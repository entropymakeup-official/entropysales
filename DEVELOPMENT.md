# 개발 및 배포 기준

이 저장소 main을 운영 정본으로 사용합니다. 작업을 시작할 때 origin/main을 갱신하고 별도 브랜치 또는 worktree에서 개발합니다. 다른 폴더의 app.js 전체를 이전 버전 그대로 덮어쓰지 않습니다.

1. 최신 main에서 작업 브랜치를 만듭니다.
2. 필요한 기능 차이만 적용합니다. 다른 작업이 main을 변경하면 병합 후 다시 검사합니다.
3. `npm run check`와 `npm test`를 통과시킵니다. 인보이스·RAW 원자적 저장 검사와 대시보드 집계를 함께 검사합니다.
4. 브라우저에서 기간/거래처 필터·집계 근거 연결을 확인합니다.
5. 검토 후 main에 통합하고 Pages 배포 성공 및 공개 파일 일치를 확인합니다.

배포 파일은 index.html, app.js, style.css, dashboard-model.js, dashboard-ui.js, sheet-sync-status.js 6개입니다. 변경한 파일의 버전 쿼리를 함께 갱신해야 합니다. 시트 반영 상태 화면은 sql/invoice-sheet-status.sql의 읽기 전용 RPC 설치가 먼저 필요합니다. 운영 절차와 한계는 SHEET-SYNC-STATUS.md를 참고합니다.

운영 데이터는 자동 테스트에 사용하지 않습니다. Excel 일괄 업로드·삭제 경로 원자성, 서버 응답 유실 후 재시도 멱등성은 별도 과제입니다. Google Sheets 연동은 별도 Apps Script/DB 설치 작업으로 관리합니다.

GitHub Pull Request와 main 변경 시 Dashboard validation이 npm ci 후 문법 및 전체 테스트를 실행합니다. 상태 RPC는 PGlite의 별도 테스트 DB로 검증하며 운영 주문을 수정하지 않습니다. 병합 전 이 검사의 성공을 확인합니다. 저장소 보호규칙 자체는 별도로 설정하지 않았습니다.
