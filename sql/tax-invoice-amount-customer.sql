-- 홈택스 계산서 금액(tax_invoice_amounts)의 거래처 연결을 승인 요청으로 고칠 수 있게 한다.
-- 금액·승인번호 등 홈택스 원본 값은 그대로 두고, customer_id 한 칸만 update로 바꿀 수 있다.
-- 새 거래처의 사업자번호(숫자만)가 계산서의 공급받는자 사업자번호와 같아야 승인된다.
-- 운영에 설치된 승인 함수가 예상과 다르면 아무것도 바꾸지 않고 멈춘다.
begin;
do $patch$
declare definition text;
 allow_marker text := $m$'invoice_drive_documents','contracts','contacts') or a is null$m$;
 check_marker text := $m$then raise exception 'INVALID_OPERATION';end if;$m$;
 tax_check text := $m$then raise exception 'INVALID_OPERATION';end if;
  if t='tax_invoice_amounts' then
   if a<>'update' or jsonb_typeof(op->'values') is distinct from 'object' or exists(select 1 from jsonb_object_keys(op->'values') k where k<>'customer_id') then raise exception 'TAX_INVOICE_AMOUNT_CUSTOMER_ONLY: 홈택스 계산서 금액은 거래처 연결만 바꿀 수 있습니다.';end if;
   if not exists(select 1 from public.tax_invoice_amounts x join public.customers c on c.id=(nullif(op->'values'->>'customer_id',''))::uuid
     where x.approval_number=op->'key'->>'approval_number'
      and pg_catalog.regexp_replace(coalesce(x.buyer_business_number,''),'[^0-9]','','g')<>''
      and pg_catalog.regexp_replace(coalesce(c.biz,''),'[^0-9]','','g')=pg_catalog.regexp_replace(x.buyer_business_number,'[^0-9]','','g')) then
    raise exception 'TAX_INVOICE_AMOUNT_BUYER_MISMATCH: 거래처 사업자번호가 계산서 공급받는자 사업자번호와 다릅니다.';end if;
  end if;$m$;
begin
 definition:=pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure);
 if position(allow_marker in definition)=0 or length(definition)-length(replace(definition,allow_marker,''))<>length(allow_marker)
  or position(check_marker in definition)=0 or length(definition)-length(replace(definition,check_marker,''))<>length(check_marker)
  or position('tax_invoice_amounts' in definition)>0 then
  raise exception 'Approval allowlist changed; review installed definition before applying tax invoice amount customer edits.';
 end if;
 definition:=replace(definition,allow_marker,$m$'invoice_drive_documents','contracts','contacts','tax_invoice_amounts') or a is null$m$);
 definition:=replace(definition,check_marker,tax_check);
 execute definition;
end $patch$;
notify pgrst,'reload schema';
commit;
