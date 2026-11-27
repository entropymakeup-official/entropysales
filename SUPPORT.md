# 경영지원 요청

세금계산서·구매확인서·수출/은행 증명서·사업자 서류처럼 공인인증서가 필요한 서류를 경영지원 담당자에게 요청하는 화면입니다. 물류 요청(LOGISTICS.md)과 같은 구조입니다.

- **전사용 단독 페이지 `support.html`**: 경영지원 담당자와 다른 팀이 쓰는 주소입니다. 로그인은 `logistics-standalone.js`를 같이 씁니다(`title:'경영지원'`). 슬랙 알림의 "요청 상세 보기" 링크(`support.html?id=<요청 id>`)가 여기로 와서 그 요청을 엽니다.
- **해외영업 대시보드(`index.html`)의 "경영지원" 탭**: "업무" 묶음의 물류 요청 아래. 상단에 "별도 페이지로 열기" 링크가 있습니다.
- 화면 코드는 `support.js`(`SupportPage.mountTab`)와 `support-model.js`. 모양은 `logistics.css`의 `lg-*` 클래스를 같이 쓰고, 요소 id만 `sp-*`로 둡니다.

설계: `docs/superpowers/specs/2026-11-27-management-support-requests-design.md`

## 동작 기준

- 회사 계정이면 누구나 요청을 올리고 목록·댓글·이력을 볼 수 있습니다. 상태 변경·결과 입력·발급본 첨부는 `support_handlers` 명단만 합니다.
- 상태: 요청 → 처리중 → 완료, 보류(사유 필수), 취소. 완료 → 처리중 되돌리기(사유 필수).
- **완료하려면 발급본(kind=result) 파일이 1개 이상 있어야 합니다.** 완료 상태에서 마지막 발급본은 지울 수 없습니다(되돌린 뒤 지움). DB 트리거가 판정합니다.
- **첨부는 요청자와 담당자만 볼 수 있습니다**(행·버킷 모두). 잔액증명처럼 민감한 서류가 있어서 물류보다 좁습니다.
- 요청자는 자기 요청이 "요청" 상태일 때만 요약 수정·취소, 열린 요청에만 근거 파일(요청 근거·기타)을 올립니다. 담당자는 취소 전이면 완료 뒤에도 정정본을 올릴 수 있습니다.
- 결과 칸(승인번호 등)은 완료 알림에 실려 슬랙 채널에 보입니다. 파일은 슬랙에 올리지 않습니다.
- 승인 절차(APPROVALS.md)는 쓰지 않고 바로 저장합니다. 연결 주문은 연결만 하고 주문 내용은 바꾸지 않습니다.

## 설치 순서 (운영 DB, 사용자 승인 후)

`sql/logistics.sql`, `sql/logistics-slack.sql`이 이미 설치돼 있어야 합니다(슬랙 ID 명단 `logistics_people`과 이름 표시 함수를 같이 씀).

1. `sql/support.sql` (**머지 전에 운영에 먼저 적용합니다.** 머지가 곧 GitHub Pages 배포라, 순서가 바뀌면 새 화면이 없는 표를 부릅니다)
2. `sql/support-storage.sql`
3. `sql/support-slack.sql`
4. 명단 넣기(실제 값은 저장소에 넣지 않습니다)

```sql
insert into public.support_handlers(email, display_name) values ('name@entropymakeup.com', '이름');
-- 슬랙 멘션은 logistics_people의 slack_user_id를 씁니다. 없으면 넣습니다.
insert into public.logistics_people(email, display_name, slack_user_id) values ('name@entropymakeup.com', '이름', 'U0123456789')
 on conflict (email) do update set slack_user_id = excluded.slack_user_id;
```

5. 슬랙 채널: 봇(물류와 같은 앱)을 채널에 초대한 뒤 Vault에 채널 ID를 넣습니다. `select vault.create_secret('C0123456789', 'support_slack_channel');` 채널이 없으면 알림은 보내지 않고 대기열에 남습니다.
6. Supabase Auth 리디렉트 허용 목록에 `https://entropymakeup-official.github.io/entropysales/support.html` 추가
7. 머지(= 정적 파일 배포): index.html, app.js, support.html, support.js, support-model.js, logistics-standalone.js, logistics.html. 바꾼 파일은 index.html·logistics.html·support.html의 버전 쿼리를 함께 올리고, app.js를 바꾸면 index.html의 app.js 해시(tests/asset-cache.test.cjs)를 갱신합니다.

퇴사·담당 변경 시: `update public.support_handlers set is_active = false where email = 'name@entropymakeup.com';`

## 검증

`npm test`의 `tests/support-db.test.cjs`(PGlite: 권한·상태·완료 조건·첨부 범위·버킷·슬랙)와 `tests/support-ui.test.cjs`(모델·데이터 계층·렌더링·단독 페이지). 가상 데이터만 씁니다.
