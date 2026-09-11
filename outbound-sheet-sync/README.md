# 주문 시트 금액 처리

`Core.js`는 기존 Apps Script 주문 반영 실행기의 순수 행 변환 함수다. 증빙 금액이 있으면 Amount 열에 그 값을 쓰고, 없으면 Qty × Unit Price를 쓴다. Qty와 Unit Price는 원래 값을 유지한다. 0원과 음수 정정도 명시 금액으로 취급한다.

`ReportAmounts.js`는 기존 Report.gs의 `reportExpected` 함수다. 보고서 검증도 관리 탭의 Amount 열을 기준으로 합산하며 반올림된 단가로 금액을 재계산하지 않는다. 주문·품목 ID, 버전, 판매유형, 유효한 숫자 검사는 유지한다. 기존 보고서 수식·차트·배치는 변경하지 않는다.

운영 Apps Script의 기존 `applyJobs` 함수와 같은 코드를 사용한다. 공개 저장소에는 실행기 자격증명, Script Properties, 실제 주문자료를 저장하지 않는다. 변경 시 운영 편집기의 해당 함수만 갱신하고 기존 초기화·인증·예약실행 설정을 유지한다. 이 파일을 GitHub Pages에 올리는 것만으로 Apps Script가 갱신되지는 않는다.

DB에는 먼저 `sql/invoice-amount-evidence.sql`을 적용하여 작업 snapshot에 `amount_override`가 포함되게 한다. 실행기 갱신 후 대시보드의 증빙금액 변경요청을 관리자 승인한다. 관리 시트의 Amount 값 및 반영 버전을 DB와 대조한 후 운영 반영 완료로 기록한다.

검증: `node --test tests/invoice-sheet-amount.test.cjs`. 기존 실행기의 재처리 방지·실패 복구·스프레드시트 API 어댑터도 변경된 Core.js와 함께 검사한다.
