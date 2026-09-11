const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('@electric-sql/pglite');

const ADMIN = '00000000-0000-0000-0000-000000000001';
const MEMBER = '00000000-0000-0000-0000-000000000002';
const OUTSIDER = '00000000-0000-0000-0000-000000000003';
const INVOICE = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';
const ITEM = '20000000-0000-0000-0000-000000000001';
const SECOND = '20000000-0000-0000-0000-000000000002';
const FREE = '20000000-0000-0000-0000-000000000003';
const root = path.join(__dirname, '../..');
const migrationPath = path.join(root, 'sql/invoice-amount-evidence.sql');

// Synthetic business schema; never connects to a server or reads credentials.
// Auth and queue fixtures supply dependencies, while approval and both replaced
// RPCs execute real SQL. Baseline RPCs below are the supplied live definitions.
const fixture = `
create role anon; create role authenticated; create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}');
insert into auth.users values
 ('${ADMIN}','entropyadmin@entropy.internal',now(),'{}','{}'),
 ('${MEMBER}','synthetic@entropymakeup.com',now(),'{}','{}'),
 ('${OUTSIDER}','synthetic@example.com',now(),'{}','{"dashboard_admin":true}');
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table public.invoices(id uuid primary key default gen_random_uuid(),no text unique not null,customer text,mgr text,order_date date,pay_date date,ship_date date,status text,ship_status text,foc boolean,note text,created_at timestamptz default now());
create table public.invoice_items(id uuid primary key default gen_random_uuid(),invoice_id uuid references public.invoices on delete cascade,invoice_no text,name text,barcode text,sales_type text,qty numeric,price numeric,created_at timestamptz default now());
create index on public.invoice_items(invoice_id);
create table public.customers(id uuid primary key default gen_random_uuid(),name text);
create table public.products(id uuid primary key default gen_random_uuid(),name text,price numeric);
create table public.stocks(id uuid primary key default gen_random_uuid(),name text,qty numeric);
create table public.documents(id uuid primary key default gen_random_uuid(),name text);
create table public.schedules(id uuid primary key default gen_random_uuid(),title text,date date);
create table public.tax_records(id uuid primary key default gen_random_uuid(),customer_id uuid,month text,status text,unique(customer_id,month));
create table public.app_settings(key text primary key,value text);
create table public.product_details(barcode text primary key,name_kr text);
create table public.invoice_drive_documents(id uuid primary key default gen_random_uuid(),invoice_id uuid references public.invoices on delete cascade,name text);
create table public.tax_invoice_amounts(approval_number text primary key,gross_amount numeric);
create schema storage;
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
create schema invoice_sheet_private;
create table invoice_sheet_private.queue(invoice_id uuid primary key,revision bigint not null default 1,synced_revision bigint not null default 0,queued_at timestamptz not null default now(),next_attempt_at timestamptz not null default now(),lease_until timestamptz,lease_token uuid,claimed_revision bigint,attempts integer not null default 0,last_error text,synced_at timestamptz);
create function invoice_sheet_private.authorize(p_secret text) returns void language plpgsql set search_path='' as $$begin
 if p_secret is distinct from 'synthetic-worker-key' then raise exception 'Unauthorized worker' using errcode='42501';end if;
end$$;
insert into public.invoices(id,no,customer,mgr,order_date,status,ship_status,foc,note) values
 ('${INVOICE}','SYNTHETIC-1','Synthetic customer','Synthetic manager','2026-01-02','Ordered','준비중',false,'Original header'),
 ('${OTHER}','SYNTHETIC-2','Synthetic customer','Synthetic manager','2026-01-03','Ordered','준비중',false,'Other invoice');
insert into public.invoice_items(id,invoice_id,invoice_no,name,barcode,sales_type,qty,price) values
 ('${ITEM}','${INVOICE}','SYNTHETIC-1','Synthetic A',null,'Paid',2,10),
 ('${SECOND}','${INVOICE}','SYNTHETIC-1','Synthetic B','SYNTHETIC-B','Paid',3,7),
 ('${FREE}','${INVOICE}','SYNTHETIC-1','Synthetic free',null,'FOC',1,0);
insert into invoice_sheet_private.queue(invoice_id) values('${INVOICE}');
-- Local outbox fixture detects any leaked approval dry-run or failed-save writes.
create function public.synthetic_queue_capture() returns trigger language plpgsql security definer set search_path='' as $$declare target uuid;begin
 if TG_TABLE_NAME='invoices' then target:=coalesce(new.id,old.id);else target:=coalesce(new.invoice_id,old.invoice_id);end if;
 insert into invoice_sheet_private.queue(invoice_id) values(target)
 on conflict(invoice_id) do update set revision=invoice_sheet_private.queue.revision+1;
 return null;
end$$;
create trigger synthetic_capture after insert or update or delete on public.invoices for each row execute function public.synthetic_queue_capture();
create trigger synthetic_capture after insert or update or delete on public.invoice_items for each row execute function public.synthetic_queue_capture();
grant usage on schema public,auth to authenticated,anon;
grant select,insert,update,delete on all tables in schema public to authenticated;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
create policy synthetic_company_access on public.invoices for all to authenticated using (auth.uid() in ('${ADMIN}','${MEMBER}')) with check (auth.uid() in ('${ADMIN}','${MEMBER}'));
create policy synthetic_company_access on public.invoice_items for all to authenticated using (auth.uid() in ('${ADMIN}','${MEMBER}')) with check (auth.uid() in ('${ADMIN}','${MEMBER}'));
`;

const baselineSave = `
CREATE OR REPLACE FUNCTION public.save_invoice_atomic(p_id text, p_invoice jsonb, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
v_input public.invoices%ROWTYPE;
v_saved public.invoices%ROWTYPE;
v_items jsonb;
BEGIN
IF p_invoice IS NULL OR jsonb_typeof(p_invoice) <> 'object' OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'Invoice must be an object and items must be an array'; END IF;
IF nullif(btrim(p_invoice->>'no'), '') IS NULL OR nullif(btrim(p_invoice->>'customer'), '') IS NULL THEN RAISE EXCEPTION 'Invoice number and customer are required'; END IF;
IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS x(value) WHERE jsonb_typeof(value) <> 'object' OR nullif(btrim(value->>'name'), '') IS NULL) THEN RAISE EXCEPTION 'Each item must be an object with a name'; END IF;
SELECT * INTO v_input FROM jsonb_populate_record(NULL::public.invoices, p_invoice);
IF p_id IS NULL THEN
INSERT INTO public.invoices (no,customer,mgr,order_date,pay_date,ship_date,status,ship_status,foc,note) VALUES (v_input.no,v_input.customer,v_input.mgr,v_input.order_date,v_input.pay_date,v_input.ship_date,v_input.status,v_input.ship_status,v_input.foc,v_input.note) RETURNING * INTO STRICT v_saved;
ELSE
SELECT * INTO STRICT v_saved FROM public.invoices WHERE id::text=p_id FOR UPDATE;
UPDATE public.invoices SET no=v_input.no,customer=v_input.customer,mgr=v_input.mgr,order_date=v_input.order_date,pay_date=v_input.pay_date,ship_date=v_input.ship_date,status=v_input.status,ship_status=v_input.ship_status,foc=v_input.foc,note=v_input.note WHERE id=v_saved.id RETURNING * INTO STRICT v_saved;
DELETE FROM public.invoice_items WHERE invoice_id=v_saved.id;
END IF;
INSERT INTO public.invoice_items (invoice_id,invoice_no,name,barcode,sales_type,qty,price) SELECT v_saved.id,v_saved.no,r.name,r.barcode,r.sales_type,r.qty,r.price FROM jsonb_populate_recordset(NULL::public.invoice_items,p_items) AS r;
SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) INTO v_items FROM public.invoice_items AS i WHERE i.invoice_id=v_saved.id;
IF jsonb_array_length(v_items) <> jsonb_array_length(p_items) THEN RAISE EXCEPTION 'Saved item count mismatch; check SELECT/DELETE/INSERT policies'; END IF;
RETURN jsonb_build_object('invoice',to_jsonb(v_saved),'items',v_items);
END;
$function$;
`;

const baselineClaim = `
CREATE OR REPLACE FUNCTION public.claim_invoice_sheet_jobs(p_secret text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare q invoice_sheet_private.queue%rowtype; token uuid; inv jsonb; items jsonb; result jsonb:='[]'::jsonb;
begin
 perform invoice_sheet_private.authorize(p_secret);
 for q in select * from invoice_sheet_private.queue
 where revision>synced_revision and next_attempt_at<=now() and (lease_until is null or lease_until<now())
 order by queued_at limit greatest(1,least(coalesce(p_limit,20),50)) for update skip locked
 loop
  token:=gen_random_uuid();
  update invoice_sheet_private.queue set lease_token=token,claimed_revision=q.revision,
   lease_until=now()+interval '10 minutes',attempts=attempts+1 where invoice_id=q.invoice_id;
  select jsonb_build_object('id',i.id,'no',i.no,'customer',i.customer,
   'mgr',to_jsonb(i)->'mgr','order_date',to_jsonb(i)->'order_date',
   'pay_date',to_jsonb(i)->'pay_date','ship_date',to_jsonb(i)->'ship_date',
   'status',to_jsonb(i)->'status','ship_status',to_jsonb(i)->'ship_status',
   'note',to_jsonb(i)->'note') into inv from public.invoices i where i.id=q.invoice_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',to_jsonb(i)->'name',
   'barcode',to_jsonb(i)->'barcode','sales_type',to_jsonb(i)->'sales_type',
   'qty',i.qty,'price',i.price) order by i.id),'[]'::jsonb) into items
   from public.invoice_items i where i.invoice_id=q.invoice_id;
  result:=result||jsonb_build_array(jsonb_build_object('invoice_id',q.invoice_id,'revision',q.revision::text,
    'lease_token',token,'deleted',inv is null,'invoice',inv,'items',items));
 end loop;
 return result;
end $function$;
`;

async function createDatabase({migrate = true} = {}) {
  const db = new PGlite();
  try {
    await db.exec(fixture + baselineSave + baselineClaim + `
      revoke all on function public.save_invoice_atomic(text,jsonb,jsonb) from public,anon;
      grant execute on function public.save_invoice_atomic(text,jsonb,jsonb) to authenticated;
      revoke all on function public.claim_invoice_sheet_jobs(text,integer) from public;
      grant execute on function public.claim_invoice_sheet_jobs(text,integer) to anon;
    `);
    await db.exec(fs.readFileSync(path.join(root, 'sql/change-approvals.sql'), 'utf8'));
    // A missing migration intentionally leaves the baseline for the first RED run.
    if (migrate && fs.existsSync(migrationPath)) await db.exec(fs.readFileSync(migrationPath, 'utf8'));
    return db;
  } catch (error) { await db.close(); throw error; }
}

function harness(db) {
  // Keep each test's outer transaction usable after an expected SQL rejection.
  const query = async (sql, params = []) => {
    await db.exec('savepoint synthetic_statement');
    try { const result = await db.query(sql, params); await db.exec('release savepoint synthetic_statement'); return result; }
    catch (error) { await db.exec('rollback to savepoint synthetic_statement; release savepoint synthetic_statement'); throw error; }
  };
  const login = async (id = ADMIN) => {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
    await db.exec('set local role authenticated');
  };
  const items = async () => (await query('select to_jsonb(i) r from public.invoice_items i where invoice_id=$1 order by id', [INVOICE])).rows.map(x => x.r);
  const invoice = async () => (await query('select to_jsonb(i) r from public.invoices i where id=$1', [INVOICE])).rows[0].r;
  const submit = async ops => (await query('select public.submit_change_request($1::jsonb,$2,$3::uuid) r', [JSON.stringify(ops), '합성 증빙 검사', randomUUID()])).rows[0].r;
  const review = async id => (await query("select public.review_change_request($1::uuid,true,'합성 검토') r", [id])).rows[0].r;
  const updateOp = async (values, id = ITEM) => ({table: 'invoice_items', action: 'update', key: {id}, before: (await items()).find(i => i.id === id), values});
  const approveUpdate = async (values, id = ITEM) => review((await submit([await updateOp(values, id)])).id);
  const invoiceOp = async (changes = {}, replacement) => {
    const before = {invoice: await invoice(), items: await items()};
    const header = Object.fromEntries(['no','customer','mgr','order_date','pay_date','ship_date','status','ship_status','foc','note'].map(k => [k, before.invoice[k]]));
    const lines = before.items.map(({name,barcode,sales_type,qty,price}) => ({name,barcode,sales_type,qty,price}));
    return {action: 'invoice', id: INVOICE, before, invoice: {...header, ...changes}, items: replacement || lines};
  };
  const snapshot = async () => {
    await db.exec('reset role');
    const result = {};
    for (const table of ['public.invoices','public.invoice_items','invoice_sheet_private.queue','approval_private.requests']) {
      result[table] = (await query(`select to_jsonb(r) r from ${table} r order by to_jsonb(r)::text`)).rows.map(x => x.r);
    }
    await db.exec('set local role authenticated');
    return result;
  };
  // Only synthetic tests use a private capability to reach constraints/guards
  // directly; actual user flows above use the unmodified submit/review RPCs.
  const directContext = async () => {
    await db.exec('reset role');
    await query('insert into approval_private.apply_context values(txid_current(),$1::uuid)', [ADMIN]);
    await db.exec('set local role authenticated');
  };
  return {query, login, items, invoice, submit, review, updateOp, approveUpdate, invoiceOp, snapshot, directContext};
}
module.exports = {createDatabase, harness, migrationPath, ADMIN, MEMBER, OUTSIDER, INVOICE, OTHER, ITEM, SECOND, FREE};
