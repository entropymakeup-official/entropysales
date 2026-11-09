-- 면세점 정산 원장에 '라인' 구분을 더한다. 같은 거래처·마감 월에 화장품(기본) 외에
-- 코코렌즈(롯데)·부산점(신세계)처럼 따로 정산·입금되는 줄을 넣기 위함.
-- 기존 행은 모두 '기본'이 되고, 금액·수량·권한은 바꾸지 않는다.
begin;

do $$
begin
  if to_regclass('public.consignment_settlements') is null then
    raise exception 'consignment-settlements.sql must be installed first';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='consignment_settlements' and column_name='line') then
    raise exception 'consignment-settlement-lines is already installed';
  end if;
end $$;

alter table public.consignment_settlements
  add column line text not null default '기본' check (line in ('기본','코코렌즈','부산점'));
alter table public.consignment_settlements drop constraint consignment_settlements_pkey;
alter table public.consignment_settlements add primary key (customer_id, month, line);

commit;
