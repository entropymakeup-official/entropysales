# 관리자 승인 변경 반영

사용자가 승인한 설계: 별도 관리자 페이지에서 변경 요청의 전후 내용을 확인하고 승인 또는 반려한다. 관리자 본인의 요청도 본인이 최종 승인할 수 있지만 저장 시 즉시 반영하는 예외는 없다.

## 계약

- 대시보드의 업무 데이터 입력, 수정, 삭제, Excel 입력은 변경 요청으로 제출한다. 승인 전 확정 데이터와 집계는 유지한다.
- 요청은 이유, 요청자, 요청시각, operations 배열을 저장한다. 각 작업은 `{table, action: insert|update|delete, key, before, values}` 또는 `{action: invoice, id, before:{invoice,items}, invoice, items}`이다. key는 해당 테이블 기본키 객체다. insert는 before=null, update/delete는 변경 전 전체 행이다. invoice는 주문과 품목을 한 트랜잭션으로 저장한다.
- RPC `submit_change_request(p_operations jsonb,p_reason text,p_client_id uuid)`는 요청을 검증해 `{id,status:'pending'}`을 반환한다. client_id는 재시도 중복 방지용이다.
- RPC `list_change_requests(p_limit integer default 100,p_offset integer default 0)`은 `{is_admin,requests}`를 반환한다. 일반 사용자는 자기 요청, 관리자는 전체 요청을 조회한다.
- RPC `review_change_request(p_id uuid,p_approve boolean,p_note text)`는 관리자를 서버에서 확인하고 승인 시 재검증과 변경 적용을 원자적으로 수행한다. 승인 시 충돌이나 오류가 있으면 pending 유지, 확정 자료 변경 없음. 반려는 사유 필수. 상태 변경은 단 한 번만 가능하다.
- 검증: 타입/필수/제약조건, 허용 테이블/필드, 변경 전 스냅샷, 외래키, 금액 및 품목 값. DB 제약 검증은 롤백되는 하위 트랜잭션에서 실행한다. 자동 검증은 원본 증빙의 업무적 진실성을 확정하지 않는다.
- 직접 쓰기는 DB 트리거로 거부하며 승인 함수 내부에서만 허용한다. 기존 회사 로그인 조회 권한은 유지한다. 관리자 식별은 서버 관리 정보이며 사용자 편집 metadata를 신뢰하지 않는다.
- 자동 WeKeep 원본 수집은 조회용 별도 스냅샷으로 기존 수집을 유지한다. 영업 업무 데이터의 수동 변경과 구분하며 승인 페이지 설명에 범위를 명시한다. 기존 DB→시트 동기화는 승인 적용 후에만 발생한다.
- 운영 DB 설치와 프론트 배포는 코드·테스트를 완료한 후 검토 가능한 상태에서 수행 여부를 보고한다. 이 설계 파일에 운영 데이터나 키를 저장하지 않는다.

## 파일과 검증

`sql/change-approvals.sql`: 요청 저장, 검증, 적용, 조회, 직접쓰기 차단. `change-requests.js`: 제출 클라이언트와 요청 상태. `admin.html`, `admin-approvals.js`, `approvals.css`: 별도 관리자 UI. `app.js`, `index.html`, `drive-documents.js`: 기존 업무 저장 흐름 연결. 테스트는 독립 PGlite DB와 합성 데이터만 사용한다.

필수 사례: 승인 전 값 보존, 관리자 자기 승인, 일반 사용자 승인 거부, 직접 쓰기 거부, 충돌·실패 롤백, 중복 요청/중복 승인, 반려, XSS 안전 표시, 저장 후 승인 대기 안내, 원본 권한 유지.
