-- 파스토 OpenAPI 동기화(설계: docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md).
-- logistics.sql → logistics-storage.sql → logistics-slack.sql → logistics-fassto.sql 다음에 설치한다. 다시 실행해도 안전하다.
-- 동기화는 사무실 PC가 anon으로 public.logistics_fassto_ingest를 부른다. 로그인 없는 호출이라 기존 트리거의 "시스템" 경로를 탄다.
begin;

-- 1) 요청의 파스토 연결 칸. 로그인한 회사 구성원은 넣거나 바꿀 수 없다.
alter table public.logistics_requests add column if not exists fassto_slip_no text;
alter table public.logistics_requests add column if not exists fassto_status_code text;
alter table public.logistics_requests add column if not exists fassto_synced_at timestamptz;
-- 동기화가 직접 만든 요청만 true. 이런 요청만 품목을 파스토 내용으로 바꾼다(사람이 넣은 품목은 덮지 않음).
alter table public.logistics_requests add column if not exists fassto_created boolean not null default false;
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_slip_no_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_slip_no_check
 check (fassto_slip_no is null or fassto_slip_no ~ '^[A-Za-z0-9_-]{1,40}$');
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_status_code_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_status_code_check
 check (fassto_status_code is null or fassto_status_code in ('ORDER','WORKING','DONE','CANCEL','SHORTAGE'));
create unique index if not exists logistics_requests_fassto_slip_no_idx on public.logistics_requests(fassto_slip_no) where fassto_slip_no is not null;

create or replace function approval_private.logistics_requests_fassto_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (select auth.uid()) is null then return new; end if;
 if tg_op = 'INSERT' then
  new.fassto_slip_no := null; new.fassto_status_code := null; new.fassto_synced_at := null; new.fassto_created := false;
 else
  new.fassto_slip_no := old.fassto_slip_no; new.fassto_status_code := old.fassto_status_code; new.fassto_synced_at := old.fassto_synced_at;
  new.fassto_created := old.fassto_created;
 end if;
 return new;
end $$;
drop trigger if exists logistics_requests_fassto_guard on public.logistics_requests;
create trigger logistics_requests_fassto_guard before insert or update on public.logistics_requests
 for each row execute function approval_private.logistics_requests_fassto_guard();

-- 2) 차량 기사 정보(요청당 0~1행). 슬랙에 실리지 않는다. 읽기는 요청자·활성 담당자, 쓰기는 활성 담당자. 취소된 요청에는 못 쓴다.
create table if not exists public.logistics_request_drivers (
 request_id uuid primary key references public.logistics_requests(id) on delete cascade,
 driver_name_text text not null default '' check (length(driver_name_text) <= 40),
 driver_phone_text text not null default '' check (length(driver_phone_text) <= 40),
 vehicle_no_text text not null default '' check (length(vehicle_no_text) <= 20),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);

create or replace function approval_private.logistics_drivers_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare st text;
begin
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 select status_code into st from public.logistics_requests where id = new.request_id for update;
 if not found then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if st = 'canceled' then raise exception 'LOGISTICS_CLOSED'; end if;
 if (select auth.uid()) is not null and not (select approval_private.logistics_is_handler()) then raise exception 'LOGISTICS_HANDLER_ONLY'; end if;
 new.driver_name_text := btrim(new.driver_name_text); new.driver_phone_text := btrim(new.driver_phone_text);
 new.vehicle_no_text := btrim(new.vehicle_no_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce((select approval_private.current_email()), 'system');
 return new;
end $$;
drop trigger if exists logistics_drivers_stamp on public.logistics_request_drivers;
create trigger logistics_drivers_stamp before insert or update on public.logistics_request_drivers
 for each row execute function approval_private.logistics_drivers_stamp();

-- 3) 동기화 기록: 재고(stock)와 출고(delivery)를 나누고, 실패 실행은 error_text에 남긴다.
alter table public.logistics_fassto_sync add column if not exists kind_code text not null default 'stock';
alter table public.logistics_fassto_sync drop constraint if exists logistics_fassto_sync_kind_code_check;
alter table public.logistics_fassto_sync add constraint logistics_fassto_sync_kind_code_check check (kind_code in ('stock','delivery'));
alter table public.logistics_fassto_sync add column if not exists error_text text not null default '';
alter table public.logistics_fassto_sync drop constraint if exists logistics_fassto_sync_error_text_check;
alter table public.logistics_fassto_sync add constraint logistics_fassto_sync_error_text_check check (length(error_text) <= 300);
create index if not exists logistics_fassto_sync_kind_idx on public.logistics_fassto_sync(kind_code, synced_at desc);

-- 4) 전용 열쇠(sha256 hex만)와 동기화 설정. approval_private라 anon·authenticated는 못 읽는다.
create table if not exists approval_private.logistics_fassto_keys (
 key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
 label_text text not null default '' check (length(label_text) <= 60),
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists approval_private.logistics_fassto_settings (
 id integer primary key check (id = 1),
 default_requester_email text not null check (default_requester_email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$')
);

-- 5) 동기화 함수. 사무실 PC가 anon 키 + 전용 열쇠로 부른다(한 트랜잭션).
create or replace function approval_private.logistics_fassto_key_ok(p_key text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(length(p_key) between 32 and 200, false) and exists(
  select 1 from approval_private.logistics_fassto_keys k
  where k.is_active and k.key_hash = encode(sha256(convert_to(p_key,'UTF8')),'hex'));
$$;

-- 동기화 품목 → logistics_replace_items 형식. 로트가 비면 유통기한이 지워지므로 유통기한을 로트 칸에도 넣는다. 최대 50줄.
-- 수량은 1~1000000(logistics_request_items.qty 검사와 같음). 형식 검사 뒤에만 정수로 바꾼다(case로 순서 보장).
create or replace function approval_private.logistics_fassto_items(p_items jsonb) returns jsonb
language sql immutable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('product_code',x.code,'product_name_text',x.name,'qty',x.qty,'lot_text',x.exp,'expires_on',x.exp) order by x.ord),'[]'::jsonb)
 from (
  select e.ord, btrim(e.v->>'product_code') code, left(btrim(coalesce(e.v->>'product_name','')),200) name,
   case when coalesce(e.v->>'qty','') ~ '^[0-9]{1,7}$' then (e.v->>'qty')::integer end qty,
   case when coalesce(e.v->>'expires_on','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then e.v->>'expires_on' else '' end exp
  from jsonb_array_elements(case when jsonb_typeof(p_items)='array' then p_items else '[]'::jsonb end) with ordinality e(v,ord)
  where jsonb_typeof(e.v->'product_code')='string' and length(btrim(e.v->>'product_code')) between 1 and 60
    and (case when coalesce(e.v->>'qty','') ~ '^[0-9]{1,7}$' then (e.v->>'qty')::integer end) between 1 and 1000000
  order by e.ord limit 50) x;
$$;

-- 품목 비교용 서명(상품코드|유통기한|수량). 줄 순서와 상관없도록 상품코드·유통기한·수량 순으로 정렬한다.
create or replace function approval_private.logistics_fassto_sig(p_items jsonb) returns text
language sql immutable security definer set search_path='' as $$
 select coalesce(string_agg(concat_ws('|',e.v->>'product_code',coalesce(e.v->>'expires_on',''),e.v->>'qty'),';'
  order by e.v->>'product_code', coalesce(e.v->>'expires_on',''), (e.v->>'qty')::integer),'')
 from jsonb_array_elements(p_items) e(v);
$$;

create or replace function approval_private.logistics_fassto_qty_text(p_items jsonb, p_total integer) returns text
language sql immutable security definer set search_path='' as $$
 select case when jsonb_array_length(p_items) > 0 then
   format('품목 %s종 · 총 %s개', jsonb_array_length(p_items), (select sum((e.v->>'qty')::integer) from jsonb_array_elements(p_items) e(v)))
  when p_total is not null then format('총 %s개', p_total) else '' end;
$$;

-- 같은 내용 댓글은 한 번만
create or replace function approval_private.logistics_fassto_comment(p_request uuid, p_body text) returns void
language plpgsql security definer set search_path='' as $$
declare b text := left(btrim(p_body),1000);
begin
 if exists(select 1 from public.logistics_request_comments c where c.request_id = p_request and c.body_text = b) then return; end if;
 insert into public.logistics_request_comments(request_id, body_text, author_email) values (p_request, b, 'fassto-sync');
end $$;

create or replace function public.logistics_fassto_ingest(p_key text, p_stock jsonb, p_deliveries jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 d jsonb; r public.logistics_requests%rowtype; v_found boolean; v_linked boolean;
 v_slip text; v_order text; v_status text; v_div text; v_shop text; v_has_items boolean; v_items jsonb; v_raw_n integer; v_total integer;
 v_email text; v_default text; v_title text; v_note text; v_old_sig text; v_invoice text; v_upd boolean;
 n_created integer := 0; n_updated integer := 0; n_canceled integer := 0; n_invoices integer := 0; n_skipped integer := 0;
 v_stock_rows integer; v_stock_warning text := ''; v_last integer; v_inv uuid;
begin
 if not approval_private.logistics_fassto_key_ok(p_key) then raise exception 'LOGISTICS_FASSTO_KEY'; end if;
 if (select auth.uid()) is not null then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 select s.default_requester_email into v_default from approval_private.logistics_fassto_settings s where s.id = 1;
 if v_default is null then raise exception 'LOGISTICS_FASSTO_SETTINGS'; end if;
 if (p_stock is not null and jsonb_typeof(p_stock) <> 'array') or (p_deliveries is not null and jsonb_typeof(p_deliveries) <> 'array') then
  raise exception 'LOGISTICS_FASSTO_BAD';
 end if;

 -- 재고: 지난 정상 갱신의 절반 미만이면 바꾸지 않는다(첫 갱신은 검사하지 않음)
 if p_stock is not null then
  select s.row_count into v_last from public.logistics_fassto_sync s where s.kind_code = 'stock' and s.error_text = '' order by s.synced_at desc, s.id desc limit 1;
  if jsonb_array_length(p_stock) = 0 or (v_last is not null and jsonb_array_length(p_stock) * 2 < v_last) then
   v_stock_warning := format('재고 %s행(지난번 %s행)이라 재고를 바꾸지 않았어요', jsonb_array_length(p_stock), coalesce(v_last,0));
  else
   v_stock_rows := approval_private.logistics_replace_fassto_stock(p_stock, 'fassto-api');
  end if;
 end if;

 for d in select e.v from jsonb_array_elements(coalesce(p_deliveries,'[]'::jsonb)) e(v) loop
  v_slip := btrim(coalesce(d->>'slip_no',''));
  v_order := btrim(coalesce(d->>'order_no',''));
  v_status := d->>'status_code';
  v_div := d->>'out_div';
  if v_slip !~ '^[A-Za-z0-9_-]{1,40}$' or v_status is null or v_status not in ('ORDER','WORKING','DONE','CANCEL','SHORTAGE')
     or v_div is null or v_div not in ('car','parcel') then
   n_skipped := n_skipped + 1; continue;
  end if;
  -- 정리하고 남은 줄이 없으면 "품목 없음"으로 본다(저장된 품목을 지우지 않음)
  v_items := case when jsonb_typeof(d->'items') = 'array' then approval_private.logistics_fassto_items(d->'items') end;
  if v_items is not null and jsonb_array_length(v_items) = 0 then v_items := null; end if;
  v_has_items := v_items is not null;
  v_raw_n := case when v_has_items then jsonb_array_length(d->'items') else 0 end;
  v_total := case when coalesce(d->>'qty_total','') ~ '^[0-9]{1,9}$' then (d->>'qty_total')::integer end;
  v_shop := left(btrim(coalesce(d->>'shop_name','')),120);
  v_linked := false; v_upd := false;

  select * into r from public.logistics_requests q where q.fassto_slip_no = v_slip for update;
  v_found := found;
  if not v_found and v_order ~ '^LG[0-9]{8}_[0-9]{3,}$' then
   select * into r from public.logistics_requests q where q.fassto_order_no = v_order and q.fassto_slip_no is null for update;
   v_found := found; v_linked := found;
  end if;

  if not v_found then
   if v_status = 'CANCEL' then n_skipped := n_skipped + 1; continue; end if;
   -- 첫 동기화 때 지난 출고완료 건이 한꺼번에 요청으로 쏟아지지 않게: 오늘(KST) 전 주문의 출고완료는 새로 만들지 않는다
   if v_status = 'DONE' and coalesce(d->>'order_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and (d->>'order_date')::date < ((now() at time zone 'UTC') + interval '9 hours')::date then
    n_skipped := n_skipped + 1; continue;
   end if;
   v_email := null;
   select lower(x.email) into v_email from (
    select p.email, 1 o from public.logistics_people p where p.display_name = btrim(coalesce(d->>'registered_by',''))
    union all
    select h.email, 2 o from public.logistics_handlers h where h.is_active and h.display_name = btrim(coalesce(d->>'registered_by',''))
   ) x order by x.o limit 1;
   v_title := left(concat_ws(' · ', nullif(v_shop,''), nullif(v_order,'')), 80);
   if v_title = '' then v_title := '파스토 ' || v_slip; end if;
   v_note := btrim('[파스토 ' || v_slip || '] ' || btrim(coalesce(d->>'remark','')));
   if v_raw_n > 50 then v_note := v_note || format(' (품목 %s줄 중 50줄만 표시)', v_raw_n); end if;
   insert into public.logistics_requests(type_code, title_text, team_code, requester_email, counterparty_text, want_date, ship_mode_code,
    qty_summary_text, note_text, fassto_slip_no, fassto_status_code, fassto_synced_at, fassto_created)
   values ('b2b', v_title, 'global', coalesce(v_email, v_default), coalesce(nullif(v_shop,''),'파스토 출고'),
    case when coalesce(d->>'order_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (d->>'order_date')::date end,
    case v_div when 'car' then 'direct' else 'parcel' end,
    left(approval_private.logistics_fassto_qty_text(coalesce(v_items,'[]'::jsonb), v_total),300), left(v_note,1000),
    v_slip, v_status, now(), true)
   returning * into r;
   if v_has_items then perform public.logistics_replace_items(r.id, v_items); end if;
   n_created := n_created + 1;
  else
   -- 품목: 동기화가 만든 요청이고 요청·접수 상태일 때만 바꾼다. 그 밖(사람이 만든 요청, 준비중 이후)에는 댓글로 알린다.
   if v_has_items then
    select coalesce(string_agg(concat_ws('|',i.product_code,coalesce(i.expires_on::text,''),i.qty::text),';'
      order by i.product_code, coalesce(i.expires_on::text,''), i.qty),'')
     into v_old_sig from public.logistics_request_items i where i.request_id = r.id;
    if approval_private.logistics_fassto_sig(v_items) <> v_old_sig then
     if r.fassto_created and r.status_code in ('requested','accepted') then
      perform public.logistics_replace_items(r.id, v_items);
      update public.logistics_requests set qty_summary_text = left(approval_private.logistics_fassto_qty_text(v_items, v_total),300) where id = r.id;
      v_upd := true;
     elsif r.status_code <> 'canceled' then
      perform approval_private.logistics_fassto_comment(r.id, '[파스토 동기화] 파스토에서 품목이 바뀌었어요: '||approval_private.logistics_fassto_qty_text(v_items, v_total));
     end if;
    end if;
   end if;
   -- 취소
   if v_status = 'CANCEL' and r.fassto_status_code is distinct from 'CANCEL' then
    if r.status_code in ('requested','accepted','preparing','on_hold') then
     update public.logistics_requests set status_code = 'canceled', status_note_text = '파스토에서 출고요청 취소' where id = r.id;
     n_canceled := n_canceled + 1;
    elsif r.status_code = 'shipped' then
     perform approval_private.logistics_fassto_comment(r.id, '[파스토 동기화] 출고완료된 요청인데 파스토에서 출고요청이 취소됐어요. 확인해 주세요.');
    end if;
   elsif v_status <> 'CANCEL' and r.status_code = 'canceled' and r.fassto_status_code = 'CANCEL' then
    perform approval_private.logistics_fassto_comment(r.id, '[파스토 동기화] 취소된 요청인데 파스토에서 출고요청이 다시 살아났어요. 확인해 주세요.');
   end if;
   if v_linked then v_upd := true; end if;
   if v_upd then n_updated := n_updated + 1; end if;
  end if;

  select * into r from public.logistics_requests q where q.id = r.id;
  -- 주문 연결: 파스토 주문번호가 대시보드 주문번호(invoices.no)와 같고 아직 연결이 없으면 잇는다.
  -- 출고완료·취소된 요청은 요약이 닫혀 있으므로 건드리지 않는다.
  if r.invoice_id is null and v_order <> '' and r.status_code not in ('shipped','canceled') then
   select i.id into v_inv from public.invoices i where i.no = v_order order by i.id limit 1;
   if v_inv is not null then update public.logistics_requests set invoice_id = v_inv where id = r.id; end if;
  end if;
  -- 택배 송장: 결과 칸이 비어 있을 때만. 상태는 바꾸지 않는다.
  select * into r from public.logistics_requests q where q.id = r.id;
  v_invoice := left(btrim(concat_ws(' ', nullif(btrim(coalesce(d->>'parcel_name','')),''), nullif(btrim(coalesce(d->>'invoice_no','')),''))),500);
  if v_div = 'parcel' and btrim(coalesce(d->>'invoice_no','')) <> '' and r.result_text = '' and r.status_code <> 'canceled' then
   update public.logistics_requests set result_text = v_invoice where id = r.id;
   n_invoices := n_invoices + 1;
  end if;
  update public.logistics_requests set fassto_slip_no = v_slip, fassto_status_code = v_status, fassto_synced_at = now() where id = r.id;
 end loop;

 if p_deliveries is not null then
  insert into public.logistics_fassto_sync(source_text, kind_code, row_count, note_text)
  values ('fassto-api','delivery', jsonb_array_length(p_deliveries),
   format('새 %s · 수정 %s · 취소 %s · 송장 %s · 건너뜀 %s', n_created, n_updated, n_canceled, n_invoices, n_skipped));
 end if;
 delete from public.logistics_fassto_sync s where s.synced_at < now() - interval '90 days'
  and s.id not in (select max(t.id) from public.logistics_fassto_sync t group by t.kind_code);
 return jsonb_build_object('stock_rows', v_stock_rows, 'stock_warning', v_stock_warning, 'created', n_created, 'updated', n_updated,
  'canceled', n_canceled, 'invoices', n_invoices, 'skipped', n_skipped);
end $$;

create or replace function public.logistics_fassto_report_error(p_key text, p_error text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not approval_private.logistics_fassto_key_ok(p_key) then raise exception 'LOGISTICS_FASSTO_KEY'; end if;
 insert into public.logistics_fassto_sync(source_text, kind_code, row_count, error_text)
 values ('fassto-api','delivery',0, left(coalesce(nullif(btrim(p_error),''),'알 수 없는 오류'),300));
end $$;

-- 6) 권한
revoke all on function approval_private.logistics_fassto_key_ok(text),approval_private.logistics_fassto_items(jsonb),
 approval_private.logistics_fassto_sig(jsonb),approval_private.logistics_fassto_qty_text(jsonb,integer),
 approval_private.logistics_fassto_comment(uuid,text) from public,anon,authenticated;
revoke all on function public.logistics_fassto_ingest(text,jsonb,jsonb),public.logistics_fassto_report_error(text,text) from public,anon,authenticated;
grant execute on function public.logistics_fassto_ingest(text,jsonb,jsonb),public.logistics_fassto_report_error(text,text) to anon;
revoke all on function approval_private.logistics_requests_fassto_guard(),approval_private.logistics_drivers_stamp() from public,anon,authenticated;
revoke all on approval_private.logistics_fassto_keys,approval_private.logistics_fassto_settings from public,anon,authenticated;

alter table public.logistics_request_drivers enable row level security;
revoke all on public.logistics_request_drivers from public,anon,authenticated;
grant select,insert,update on public.logistics_request_drivers to authenticated;
drop policy if exists logistics_drivers_read on public.logistics_request_drivers;
create policy logistics_drivers_read on public.logistics_request_drivers for select to authenticated
 using ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_drivers_insert on public.logistics_request_drivers;
create policy logistics_drivers_insert on public.logistics_request_drivers for insert to authenticated
 with check ((select approval_private.logistics_is_handler()));
drop policy if exists logistics_drivers_update on public.logistics_request_drivers;
create policy logistics_drivers_update on public.logistics_request_drivers for update to authenticated
 using ((select approval_private.logistics_is_handler())) with check ((select approval_private.logistics_is_handler()));

commit;
