-- 면세점(판매분 정산) 월별 정산 원장. 대시보드는 읽기만 한다.
-- 입력·정정은 마감자료 원본을 확인한 뒤 관리자 승인을 받아 postgres로 직접 실행한다.
-- 금액은 모두 원화 납품가(VAT 별도) 기준이며, 실입금만 통장 기준 실제 금액이다.
begin;

do $$
begin
  if to_regclass('public.consignment_settlements') is not null then
    raise exception 'consignment-settlements is already installed';
  end if;
end $$;

create table public.consignment_settlements (
  customer_id uuid not null references public.customers(id),
  month date not null check (extract(day from month) = 1),
  stocked_supply numeric not null,            -- 입고−반품 × 납품가 (계산서 발행 기준 = 대시보드 매출 기준)
  sold_supply numeric not null,               -- 판매수량 × 납품가 (면세점 정산 기준)
  deposited_amount numeric,                   -- 통장 실입금 (확인 전이면 null)
  deposited_date date,
  ending_stock_qty integer not null check (ending_stock_qty >= 0),
  ending_stock_supply numeric not null check (ending_stock_supply >= 0), -- 월말 매장 재고 × 납품가 = 미정산 잔액
  evidence jsonb not null default '{}'::jsonb,  -- {closing_url, reconciliation_url}
  note text,
  created_at timestamptz not null default now(),
  primary key (customer_id, month),
  check ((deposited_amount is null) = (deposited_date is null))
);

alter table public.consignment_settlements enable row level security;
revoke all on table public.consignment_settlements from public, anon, authenticated;
grant select on table public.consignment_settlements to authenticated;

create policy consignment_settlements_company_read on public.consignment_settlements
  for select to authenticated
  using (
    split_part(auth.jwt() ->> 'email', '@', 2) = 'entropymakeup.com'
    or auth.jwt() ->> 'email' = 'entropyadmin@entropy.internal'
  );

commit;
