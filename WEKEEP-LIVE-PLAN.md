# 위킵 실시간 재고 구현 계획

사용자 승인: 2026-09-10 ‘실시간 재고’ 신규 페이지와 API 없는 수집 진행 요청.

목표: 위킵 브라우저 표를 주기적으로 읽고 별도 스냅샷으로 저장하여 기존 회사 로그인 사용자에게 표시한다. 기존 stocks·주문·제품 연결은 수정하지 않는다.

구조: CUA 브라우저 수집 → 로그인된 대시보드의 수집 자료 반영 창 → Supabase 인증 RPC → 신규 재고 페이지. 수집은 Codex heartbeat 10분 후보, 화면은 열려 있을 때 60초마다 저장된 자료 재조회. heartbeat 등록 가능 주기를 실제 도구로 확인한다. 로그인/호스트 미가동 시 실패를 알리고 마지막 성공 스냅샷 유지. 별도 인증키나 위킵 API 호출 없음.

인터페이스: snapshot={version:1,source:'wekeep',collected_at:ISO8601,expected_count:integer,rows:[{name:string,code:string,supplier:string,available:integer,safety:integer,held:integer,defective:integer}]}. SKU는 원본 표에 없으므로 지어내지 않고 원본 행을 그대로 유지. 관리코드 빈 문자열 허용, 행 순서를 제품 식별키로 사용하지 않음. 전체 원본 rows를 보관하며 병합하지 않음. 최대10000행/4MB, 건수 일치, 미래5분/과거24시간 밖 스냅샷 거절. 최신 collected_at보다 오래된 쓰기 거절. 기존 회사 이메일 도메인·내부관리계정에만 읽기/쓰기 허용. 오류 시 공개 메시지로 실패를 알린다.

## Task 1 — 모델 및 화면
- [ ] live-inventory.js: UMD 순수 validateSnapshot, fromCells, deriveStatus 및 mount({document,read,write}) 구현. fromCells는 11열 표에서 이름0/코드1/공급처2/가용6/안전7/유보8/하자9 사용. 콤마 음수 '-,128' 정규화, 빈 숫자·비숫자 거절. 중복코드/빈코드 보존. innerHTML 삽입 문자열 이스케이프.
- [ ] index.html/app.js/style.css: 왼쪽 메뉴 ‘실시간 재고’ inventory 추가. 검색, 재고종류별 합계, 음수/빈코드 개수, 마지막 수집시각, 15분 이상 지연표시, 새로고침, 위킵 원본 링크. 수집 자료 반영은 접힌 details의 textarea+검증/저장 버튼. 저장 완료는 RPC 응답 검증 후 표시. 페이지 전환/로그아웃 시 타이머와 상태 정리, 겹친 응답 무시. 미설치/빈자료/실패/세션만료 분리.
- [ ] tests/live-inventory.test.cjs: 잘못된 수량, 누락행, 오래된/미래시각, 빈코드, 음수, HTML문자, 상태전환을 먼저 실패 확인하고 통과.

## Task 2 — 원자적 저장
- [ ] sql/wekeep-live.sql: private singleton snapshot 및 get_wekeep_inventory()/save_wekeep_inventory(p_snapshot jsonb). auth.uid+회사이메일 인증, search_path 고정, public/anon execute 회수. 기본테이블 비공개. advisory transaction lock 후 시각 단조증가 및 서버 검증, 전체 스냅샷 원자교체. 성공응답 {saved:true,collected_at,row_count}; read {snapshot:null|payload,checked_at:ISO}.
- [ ] tests/wekeep-live-db.test.cjs: PGlite auth stub으로 무권한/외부계정 거부, 정상/음수/빈코드 저장, 부분자료/오래된자료 거부, 이전자료 보존을 실행.

## Task 3 — 연결 및 검증
- [ ] 실제 위킵 전체188행 재수집, 페이지별11열/합계건수 검증 후 브라우저 UI로만 스냅샷 전달. 운영DB 설치는 기존 권한 확인 후 수행.
- [ ] 전체 npm test/check, 로컬 합성 브라우저 검증, 독립 코드리뷰. 최신 main 통합 뒤 draft PR 또는 배포 권한 범위에 맞춰 게시; 공개 파일과 배포 상태 검증.
- [ ] 10분 heartbeat: 위킵 로그인·전수 수집·UI 반영 확인, 정상은 조용히/실패나 재로그인 필요만 알림. 갱신 실패 시 로그인 우회·자료0 덮어쓰기 금지. 기존 자동화 중복 확인 후 등록.
- [ ] 운영 인수인계와 실행 가이드 저장. 미완료 단계 및 접근 제한을 명확히 보고.
