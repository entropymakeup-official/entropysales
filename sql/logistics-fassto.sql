-- 물류 요청 파스토 양식(설계: docs/superpowers/specs/2026-11-20-logistics-fassto-forms-design.md).
-- sql/logistics.sql → logistics-storage.sql → logistics-slack.sql 다음에 설치한다. 다시 실행해도 안전하다.
begin;

-- 1) 파스토 상품 목록(로트별 행)과 갱신 기록. 쓰기는 logistics_replace_fassto_stock만 한다.
create table if not exists public.logistics_fassto_stock (
 id bigint generated always as identity primary key,
 product_code text not null check (length(btrim(product_code)) between 1 and 60),
 barcode text not null default '' check (length(barcode) <= 60),
 product_name text not null default '' check (length(product_name) <= 200),
 kind_text text not null default '' check (length(kind_text) <= 40),
 lot_text text not null default '' check (length(lot_text) <= 60),
 expires_on date,
 available_qty integer not null default 0
);
create index if not exists logistics_fassto_stock_code_idx on public.logistics_fassto_stock(product_code);

create table if not exists public.logistics_fassto_sync (
 id bigint generated always as identity primary key,
 synced_at timestamptz not null default now(),
 source_text text not null check (source_text in ('fms-browser','fassto-api')),
 row_count integer not null check (row_count >= 0),
 note_text text not null default '' check (length(note_text) <= 300)
);
create index if not exists logistics_fassto_sync_at_idx on public.logistics_fassto_sync(synced_at desc);

-- 전체를 지우고 새로 넣는다(한 트랜잭션). SQL 편집기·서비스 역할만 실행한다. 상품코드는 JSON 문자열만 받는다(앞자리 0 유지).
create or replace function approval_private.logistics_replace_fassto_stock(rows jsonb, source text) returns integer
language plpgsql security definer set search_path='' as $$
declare p_rows jsonb := $1; p_source text := $2; n integer;
begin
 if (select auth.uid()) is not null then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if p_source is null or p_source not in ('fms-browser','fassto-api') then raise exception 'LOGISTICS_STOCK_BAD_SOURCE'; end if;
 if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'LOGISTICS_STOCK_EMPTY'; end if;
 if exists(select 1 from jsonb_array_elements(p_rows) e(v) where jsonb_typeof(e.v->'product_code') is distinct from 'string') then
  raise exception 'LOGISTICS_STOCK_CODE_NOT_TEXT';
 end if;
 delete from public.logistics_fassto_stock where true;
 insert into public.logistics_fassto_stock(product_code,barcode,product_name,kind_text,lot_text,expires_on,available_qty)
 select btrim(e.v->>'product_code'), btrim(coalesce(e.v->>'barcode','')), btrim(coalesce(e.v->>'product_name','')), btrim(coalesce(e.v->>'kind_text','')),
  btrim(coalesce(e.v->>'lot_text','')), nullif(btrim(coalesce(e.v->>'expires_on','')),'')::date, coalesce(nullif(btrim(coalesce(e.v->>'available_qty','')),'')::numeric::integer,0)
 from jsonb_array_elements(p_rows) e(v);
 get diagnostics n = row_count;
 insert into public.logistics_fassto_sync(source_text,row_count) values (p_source,n);
 return n;
end $$;

-- 2) 파스토 주문번호: LG + KST 날짜 + _ + 그날 순번(3자리 이상). 클라이언트 값은 무시하고, 한 번 정하면 바꾸지 않는다.
alter table public.logistics_requests add column if not exists fassto_order_no text;
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_order_no_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_order_no_check
 check (fassto_order_no is null or fassto_order_no ~ '^[A-Za-z0-9_-]{1,40}$');
create unique index if not exists logistics_requests_fassto_order_no_idx on public.logistics_requests(fassto_order_no) where fassto_order_no is not null;

create or replace function approval_private.logistics_next_order_no(p_day date) returns text
language plpgsql security definer set search_path='' as $$
declare v_prefix text := 'LG'||to_char(p_day,'YYYYMMDD'); v_n integer;
begin
 perform pg_advisory_xact_lock(72430011);
 select coalesce(max(split_part(fassto_order_no,'_',2)::integer),0)+1 into v_n
  from public.logistics_requests where fassto_order_no ~ ('^'||v_prefix||'_[0-9]+$');
 return v_prefix||'_'||lpad(v_n::text,greatest(3,length(v_n::text)),'0');
end $$;

create or replace function approval_private.logistics_requests_order_no() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op = 'INSERT' then
  new.fassto_order_no := approval_private.logistics_next_order_no(((now() at time zone 'UTC') + interval '9 hours')::date);
 elsif old.fassto_order_no is not null or (select auth.uid()) is not null then
  new.fassto_order_no := old.fassto_order_no; -- 시스템만 설치 전 요청을 한 번 채울 수 있다
 end if;
 return new;
end $$;
drop trigger if exists logistics_requests_order_no on public.logistics_requests;
create trigger logistics_requests_order_no before insert or update on public.logistics_requests for each row execute function approval_private.logistics_requests_order_no();

-- 설치 전 요청 채우기(등록 KST 날짜별 등록순)
with n as (
 select id, 'LG'||to_char((created_at at time zone 'UTC') + interval '9 hours','YYYYMMDD')||'_'||
  lpad(rn::text,greatest(3,length(rn::text)),'0') as no
 from (select id, created_at, row_number() over (partition by ((created_at at time zone 'UTC') + interval '9 hours')::date order by created_at, id) as rn
       from public.logistics_requests where fassto_order_no is null) s)
update public.logistics_requests r set fassto_order_no = n.no from n where r.id = n.id;

-- 3) 받는 곳(요청당 0~1행). 요청자 본인과 활성 담당자만 읽고 쓴다.
create table if not exists public.logistics_request_recipients (
 request_id uuid primary key references public.logistics_requests(id) on delete cascade,
 name_text text not null default '' check (length(name_text) <= 100),
 phone_text text not null default '' check (length(phone_text) <= 40),
 postal_text text not null default '' check (length(postal_text) <= 20),
 country_code text not null default '' check (country_code ~ '^([A-Z]{2})?$'),
 state_text text not null default '' check (length(state_text) <= 100),
 city_text text not null default '' check (length(city_text) <= 100),
 district_text text not null default '' check (length(district_text) <= 100),
 address1_text text not null default '' check (length(address1_text) <= 300),
 address2_text text not null default '' check (length(address2_text) <= 300),
 email_text text not null default '' check (length(email_text) <= 200),
 tax_id_text text not null default '' check (length(tax_id_text) <= 60),
 courier_text text not null default '' check (length(courier_text) <= 60),
 incoterms_code text not null default '' check (incoterms_code in ('','DAP','DDU','DDP')),
 currency_code text not null default '' check (currency_code in ('','USD','JPY','EUR')),
 sender_name_text text not null default '' check (length(sender_name_text) <= 100),
 sender_phone_text text not null default '' check (length(sender_phone_text) <= 40),
 sender_address_text text not null default '' check (length(sender_address_text) <= 300),
 sender_email_text text not null default '' check (length(sender_email_text) <= 200),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);

create or replace function approval_private.logistics_can_see_recipient(p_request uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and ((select approval_private.logistics_is_handler()) or exists(
  select 1 from public.logistics_requests q where q.id=p_request and q.requester_email=(select approval_private.current_email())));
$$;

-- 요청 쪽 쓰기 규칙: 요청자는 requested에서만, 담당자는 shipped·canceled 전까지. 시스템(auth.uid() 없음)은 건너뛴다.
create or replace function approval_private.logistics_request_write_check(p_request uuid) returns void
language plpgsql security definer set search_path='' as $$
declare st text; req text; actor text := (select approval_private.current_email());
begin
 if (select auth.uid()) is null then return; end if;
 select status_code, requester_email into st, req from public.logistics_requests where id=p_request for update;
 if not found then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if st in ('shipped','canceled') then raise exception 'LOGISTICS_CLOSED'; end if;
 if not (select approval_private.logistics_is_handler()) and (actor is distinct from req or st <> 'requested') then raise exception 'LOGISTICS_FORBIDDEN'; end if;
end $$;

create or replace function approval_private.logistics_recipients_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare is_h boolean := (select approval_private.logistics_is_handler()); is_system boolean := (select auth.uid()) is null;
begin
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 perform approval_private.logistics_request_write_check(new.request_id);
 new.name_text := btrim(new.name_text); new.phone_text := btrim(new.phone_text); new.postal_text := btrim(new.postal_text);
 new.country_code := upper(btrim(new.country_code)); new.state_text := btrim(new.state_text); new.city_text := btrim(new.city_text);
 new.district_text := btrim(new.district_text); new.address1_text := btrim(new.address1_text); new.address2_text := btrim(new.address2_text);
 new.email_text := btrim(new.email_text); new.tax_id_text := btrim(new.tax_id_text); new.courier_text := btrim(new.courier_text);
 new.sender_name_text := btrim(new.sender_name_text); new.sender_phone_text := btrim(new.sender_phone_text);
 new.sender_address_text := btrim(new.sender_address_text); new.sender_email_text := btrim(new.sender_email_text);
 -- 운송사·Incoterms·발송인은 담당자만 정한다
 if not is_system and not is_h then
  if tg_op = 'INSERT' and (new.courier_text,new.incoterms_code,new.sender_name_text,new.sender_phone_text,new.sender_address_text,new.sender_email_text)
     is distinct from ('','','','','','') then raise exception 'LOGISTICS_HANDLER_ONLY'; end if;
  if tg_op = 'UPDATE' and (new.courier_text,new.incoterms_code,new.sender_name_text,new.sender_phone_text,new.sender_address_text,new.sender_email_text)
     is distinct from (old.courier_text,old.incoterms_code,old.sender_name_text,old.sender_phone_text,old.sender_address_text,old.sender_email_text) then
   raise exception 'LOGISTICS_HANDLER_ONLY';
  end if;
 end if;
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce((select approval_private.current_email()), 'system');
 return new;
end $$;
drop trigger if exists logistics_recipients_stamp on public.logistics_request_recipients;
create trigger logistics_recipients_stamp before insert or update on public.logistics_request_recipients for each row execute function approval_private.logistics_recipients_stamp();

-- 4) 품목 줄. 읽기는 회사 구성원, 쓰기는 요약 수정과 같은 규칙. line_no 1~50 + (request_id,line_no) 유일 = 요청당 최대 50줄.
create table if not exists public.logistics_request_items (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 line_no integer not null check (line_no between 1 and 50),
 product_code text not null check (length(btrim(product_code)) between 1 and 60),
 product_name_text text not null default '' check (length(product_name_text) <= 200),
 qty integer not null check (qty between 1 and 1000000),
 lot_text text not null default '' check (length(lot_text) <= 60),
 expires_on date,
 en_name_text text not null default '' check (length(en_name_text) <= 200),
 weight_kg numeric(10,3) check (weight_kg is null or weight_kg > 0),
 unit_price numeric(14,2) check (unit_price is null or unit_price >= 0),
 hs_code_text text not null default '' check (hs_code_text ~ '^[0-9.]{0,13}$'),
 created_at timestamptz not null default now(),
 unique (request_id, line_no)
);

create or replace function approval_private.logistics_items_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op = 'DELETE' then
  -- 요청 삭제(on delete cascade)는 시스템만 하므로 그대로 둔다
  perform approval_private.logistics_request_write_check(old.request_id);
  return old;
 end if;
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 perform approval_private.logistics_request_write_check(new.request_id);
 new.product_code := btrim(new.product_code); new.product_name_text := btrim(new.product_name_text);
 new.lot_text := btrim(new.lot_text); new.en_name_text := btrim(new.en_name_text); new.hs_code_text := btrim(new.hs_code_text);
 if new.lot_text = '' then new.expires_on := null; end if; -- 유통기한은 로트를 지정할 때만
 return new;
end $$;
drop trigger if exists logistics_items_guard on public.logistics_request_items;
create trigger logistics_items_guard before insert or update or delete on public.logistics_request_items for each row execute function approval_private.logistics_items_guard();

-- 품목 전체 바꾸기(한 트랜잭션). 호출자 권한으로 돌아 RLS와 위 트리거가 그대로 적용된다.
create or replace function public.logistics_replace_items(p_request uuid, p_items jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'LOGISTICS_ITEM_BAD'; end if;
 if jsonb_array_length(p_items) > 50 then raise exception 'LOGISTICS_ITEM_LIMIT'; end if;
 if exists(select 1 from jsonb_array_elements(p_items) e(v) where jsonb_typeof(e.v->'product_code') is distinct from 'string') then
  raise exception 'LOGISTICS_ITEM_BAD';
 end if;
 perform approval_private.logistics_request_write_check(p_request); -- 빈 목록으로 지울 때도 권한을 본다
 delete from public.logistics_request_items where request_id = p_request;
 insert into public.logistics_request_items(request_id,line_no,product_code,product_name_text,qty,lot_text,expires_on,en_name_text,weight_kg,unit_price,hs_code_text)
 select p_request, e.ord::integer, e.v->>'product_code', coalesce(e.v->>'product_name_text',''), (e.v->>'qty')::integer,
  coalesce(e.v->>'lot_text',''), nullif(coalesce(e.v->>'expires_on',''),'')::date, coalesce(e.v->>'en_name_text',''),
  nullif(coalesce(e.v->>'weight_kg',''),'')::numeric, nullif(coalesce(e.v->>'unit_price',''),'')::numeric, coalesce(e.v->>'hs_code_text','')
 from jsonb_array_elements(p_items) with ordinality e(v, ord);
 get diagnostics n = row_count;
 return n;
end $$;

-- 5) 권한
revoke all on function approval_private.logistics_replace_fassto_stock(jsonb,text) from public,anon,authenticated;
revoke all on function approval_private.logistics_next_order_no(date),approval_private.logistics_requests_order_no(),
 approval_private.logistics_recipients_stamp(),approval_private.logistics_items_guard() from public,anon,authenticated;
revoke all on function approval_private.logistics_request_write_check(uuid) from public,anon;
grant execute on function approval_private.logistics_request_write_check(uuid) to authenticated;
revoke all on function approval_private.logistics_can_see_recipient(uuid) from public,anon;
grant execute on function approval_private.logistics_can_see_recipient(uuid) to authenticated;
revoke all on function public.logistics_replace_items(uuid,jsonb) from public,anon;
grant execute on function public.logistics_replace_items(uuid,jsonb) to authenticated;

alter table public.logistics_fassto_stock enable row level security;
alter table public.logistics_fassto_sync enable row level security;
alter table public.logistics_request_recipients enable row level security;
alter table public.logistics_request_items enable row level security;

revoke all on public.logistics_fassto_stock,public.logistics_fassto_sync,public.logistics_request_recipients,public.logistics_request_items from public,anon,authenticated;
grant select on public.logistics_fassto_stock,public.logistics_fassto_sync to authenticated;
grant select,insert,update on public.logistics_request_recipients to authenticated;
grant select,insert,update,delete on public.logistics_request_items to authenticated;

drop policy if exists logistics_fassto_stock_read on public.logistics_fassto_stock;
create policy logistics_fassto_stock_read on public.logistics_fassto_stock for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_fassto_sync_read on public.logistics_fassto_sync;
create policy logistics_fassto_sync_read on public.logistics_fassto_sync for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_recipients_read on public.logistics_request_recipients;
create policy logistics_recipients_read on public.logistics_request_recipients for select to authenticated using ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_recipients_insert on public.logistics_request_recipients;
create policy logistics_recipients_insert on public.logistics_request_recipients for insert to authenticated with check ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_recipients_update on public.logistics_request_recipients;
create policy logistics_recipients_update on public.logistics_request_recipients for update to authenticated
 using ((select approval_private.logistics_can_see_recipient(request_id))) with check ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_items_read on public.logistics_request_items;
create policy logistics_items_read on public.logistics_request_items for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_items_insert on public.logistics_request_items;
create policy logistics_items_insert on public.logistics_request_items for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_items_update on public.logistics_request_items;
create policy logistics_items_update on public.logistics_request_items for update to authenticated
 using ((select approval_private.is_company_member())) with check ((select approval_private.is_company_member()));
drop policy if exists logistics_items_delete on public.logistics_request_items;
create policy logistics_items_delete on public.logistics_request_items for delete to authenticated using ((select approval_private.is_company_member()));
commit;
