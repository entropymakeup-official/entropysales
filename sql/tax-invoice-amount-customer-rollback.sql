-- sql/tax-invoice-amount-customer.sql 되돌리기: 승인 함수에서 tax_invoice_amounts 허용과 거래처 연결 검사를 뺀다.
-- 이미 승인돼 바뀐 거래처 연결은 그대로 둔다. 설치된 정의가 예상과 다르면 멈춘다.
begin;
do $patch$
declare definition text; start_pos int; end_pos int;
 allow_marker text := $m$'invoice_drive_documents','contracts','contacts','tax_invoice_amounts') or a is null$m$;
 check_start text := $m$then raise exception 'INVALID_OPERATION';end if;
  if t='tax_invoice_amounts' then$m$;
 check_end text := $m$TAX_INVOICE_AMOUNT_BUYER_MISMATCH: 거래처 사업자번호가 계산서 공급받는자 사업자번호와 다릅니다.';end if;
  end if;$m$;
begin
 definition:=pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure);
 start_pos:=position(check_start in definition);end_pos:=position(check_end in definition);
 if position(allow_marker in definition)=0 or length(definition)-length(replace(definition,allow_marker,''))<>length(allow_marker)
  or start_pos=0 or end_pos=0 or end_pos<start_pos then
  raise exception 'Approval allowlist changed; review installed definition before rolling back tax invoice amount customer edits.';
 end if;
 definition:=substr(definition,1,start_pos-1)||$m$then raise exception 'INVALID_OPERATION';end if;$m$||substr(definition,end_pos+length(check_end));
 definition:=replace(definition,allow_marker,$m$'invoice_drive_documents','contracts','contacts') or a is null$m$);
 execute definition;
end $patch$;
notify pgrst,'reload schema';
commit;
