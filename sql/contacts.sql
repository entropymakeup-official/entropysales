-- Additive contact register. Install after contracts.sql and the current approval migrations.
-- Does not modify existing business data or pending approval requests.
begin;
create table public.contacts (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid references public.customers(id) on delete restrict,
 company text not null default '', person text not null default '',
 person_en text not null default '', title text not null default '', duty text not null default '',
 department text not null default '', country text not null default '',
 mobile text not null default '', phone text not null default '', fax text not null default '',
 email text not null default '', messenger text not null default '', website text not null default '',
 address text not null default '', tags text not null default '', note text not null default '',
 status text not null default '활성' check(status in ('활성','퇴사·변경','보류')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint contacts_required check(company<>'' and person<>''),
 constraint contacts_communication check(mobile<>'' or phone<>'' or email<>'' or messenger<>'')
);
create unique index contacts_email_unique on public.contacts(lower(email)) where email<>'';
create unique index contacts_company_person_unique on public.contacts(lower(company),lower(person));
create index contacts_customer on public.contacts(customer_id);
create index contacts_created on public.contacts(created_at desc,id);
alter table public.contacts enable row level security;
revoke all on public.contacts from public,anon,authenticated;
grant select on public.contacts to authenticated;

create function approval_private.can_read_contacts() returns boolean language plpgsql security definer set search_path='' as $$
begin perform approval_private.identity();return true;end $$;
revoke all on function approval_private.can_read_contacts() from public,anon,authenticated;
grant execute on function approval_private.can_read_contacts() to authenticated;
create policy contacts_company_read on public.contacts for select to authenticated using ((select approval_private.can_read_contacts()));
create trigger require_change_approval before insert or update or delete on public.contacts for each row execute function approval_private.require_approval();
create trigger require_approval_truncate before truncate on public.contacts for each statement execute function approval_private.require_approval();

create function approval_private.validate_contact() returns trigger language plpgsql security definer set search_path='' as $$
declare k text; v text; normalized jsonb := '{}';
begin
 foreach k in array array['company','person','person_en','title','duty','department','country','mobile','phone','fax','email','messenger','website','address','tags','note','status'] loop
  v:=regexp_replace(to_jsonb(new)->>k,'^[[:space:]]+|[[:space:]]+$','','g');
  if v is null or length(v)>4000 then raise exception '연락처 항목은 4000자 이하의 문자열로 입력하세요: %',k;end if;
  normalized:=normalized||jsonb_build_object(k,v);
 end loop;
 new:=jsonb_populate_record(new,normalized);
 if new.company='' or new.person='' then raise exception '업체와 담당자 이름은 필수입니다.';end if;
 if new.mobile='' and new.phone='' and new.email='' and new.messenger='' then raise exception '연락수단을 한 가지 이상 입력하세요.';end if;
 if new.email<>'' and (length(new.email)>254 or new.email !~ '^[^[:space:]@]+@[^[:space:]@.]+([.][^[:space:]@.]+)+$') then raise exception '이메일 형식을 확인하세요.';end if;
 if new.status not in ('활성','퇴사·변경','보류') then raise exception '연락처 상태를 확인하세요.';end if;
 new.updated_at:=clock_timestamp();return new;
end $$;
revoke all on function approval_private.validate_contact() from public,anon,authenticated;
create trigger validate_contact before insert or update on public.contacts for each row execute function approval_private.validate_contact();

-- Extend exactly the inspected installed allowlist. Preserve all deployed function logic.
do $patch$
declare definition text; marker text := '''invoice_drive_documents'',''contracts'') or a is null';
begin
 definition:=pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure);
 if position(marker in definition)=0 or length(definition)-length(replace(definition,marker,''))<>length(marker) then
  raise exception 'Approval allowlist changed; review installed definition before applying contacts.';
 end if;
 execute replace(definition,marker,'''invoice_drive_documents'',''contracts'',''contacts'') or a is null');
end $patch$;
notify pgrst,'reload schema';
commit;
