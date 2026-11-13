-- 면세점 정산 검증용 칸 추가. 기존 칸·행·권한은 바꾸지 않고 비어 있을 수 있는 칸만 더한다.
-- 수량(기초·입고·반품·판매)은 마감자료 상품행 합계, 반품은 양수 개수.
-- verified_by/verified_at은 원본(마감자료·계산서·통장)을 대조한 사람과 시각.
begin;

do $$
begin
  if to_regclass('public.consignment_settlements') is null then
    raise exception 'consignment-settlements.sql must be installed first';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='consignment_settlements' and column_name='opening_stock_qty') then
    raise exception 'consignment-settlement-checks is already installed';
  end if;
end $$;

alter table public.consignment_settlements
  add column opening_stock_qty integer check (opening_stock_qty >= 0),
  add column in_qty integer check (in_qty >= 0),
  add column return_qty integer check (return_qty >= 0),
  add column sold_qty integer,
  add column verified_by text,
  add column verified_at timestamptz,
  add constraint consignment_settlements_verified_pair check ((verified_by is null) = (verified_at is null));

commit;
