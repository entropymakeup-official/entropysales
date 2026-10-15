# 업무 목록

글로벌 영업팀의 할 일을 담당자·기한·상태로 관리하는 메뉴입니다. 슬랙·메일·드라이브의 논의는 claude.ai의 "글로벌 영업 할 일 수집함" 페이지에서 후보로 모아 검토한 뒤 이 목록으로 보냅니다. 직접 추가도 할 수 있습니다.

## 화면

- 탭: 전체 목록(열린 할 일) · 담당자별 탭(본부원마다 하나, 열린 할 일 수와 지연 수 표시) · 담당 미지정 · 완료.
- 담당자를 정하면 그 사람의 탭에 모입니다. 완료 탭은 끝난 할 일만 최근 완료 순으로 보여 주며 담당자와 기간(이번 주·이번 달·전체)으로 거를 수 있습니다.
- 위쪽 "할 일 수집하기"는 claude.ai 수집 페이지를 새 탭으로 엽니다.

## 동작 기준

- 승인 없이 바로 저장합니다. 변경 요청·관리자 승인(APPROVALS.md) 대상이 아닙니다.
- 회사 계정(`@entropymakeup.com`)으로 로그인한 사람만 읽고 추가·수정할 수 있습니다. 삭제 권한은 없고 "목록에서 숨기기"만 있습니다.
- 담당자·기한·상태·제목·숨김을 바꾸면 DB 트리거가 `team_task_history`에 이력을 남깁니다. 화면은 이력을 쓰지 않습니다.
- 완료로 바꾸면 완료자·완료 시각이 자동으로 채워지고, 다른 상태로 되돌리면 지워집니다.
- 등록 출처(`source_key`)는 중복될 수 없어 같은 논의가 두 번 등록되지 않습니다.
- 원문 전체·금액·단가·연락처는 저장하지 않습니다. 저장 전에 금액·전화번호·메일 형태가 보이면 한 번 더 확인을 받습니다.

## 담당자 명단

`team_task_members`에 담당자로 지정할 수 있는 사람(회사 메일·표시 이름)을 둡니다. 실제 명단은 공개 저장소에 넣지 않고 DB에 직접 넣습니다. 화면에서는 고칠 수 없습니다.

```sql
insert into public.team_task_members(email, display_name, sort_order) values ('name@entropymakeup.com', '이름', 10);
update public.team_task_members set is_active = false where email = 'name@entropymakeup.com';
```

## 수집 페이지에서 들어오는 경로

수집 페이지의 "대시보드로 보내기"는 페이지 안의 보낼 함에만 저장합니다. 본부장 PC의 Claude 예약 작업이 10분마다 보낼 함을 읽어 `team_tasks`에 넣고 보낼 함을 비웁니다.

- 중계 입력은 로그인 사용자가 없으므로 등록자는 `이름(수집 페이지)` 형태의 글자로 남습니다.
- 제안 담당자 이름이 `team_task_members.display_name`과 정확히 같으면 담당자로 지정하고, 아니면 `suggested_assignee_text`로만 남깁니다.
- 이미 같은 `source_key`가 있으면 건너뜁니다.
- PC나 앱이 꺼져 있으면 중계가 멈추고, 다시 켜지면 쌓인 것을 옮깁니다.

## 운영 적용

1. `sql/team-tasks.sql`을 실행합니다. 여러 번 실행해도 안전합니다.
2. 담당자 명단을 넣습니다(위 SQL).
3. `index.html`, `app.js`, `team-tasks.js`, `team-tasks.css`를 배포합니다.

## 검증

- `npm run check`, `npm test` (`tests/team-tasks.test.cjs`, `tests/team-tasks-db.test.cjs`)
- 배포 후: 업무 목록 메뉴 → 직접 추가 → 담당자·상태 변경 → 상세의 변경 이력 확인.
