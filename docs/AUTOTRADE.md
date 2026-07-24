# Longview 국내 자동투자 운영 안내

자동매매는 한국투자증권(KIS) 국내주식 전용이며 미국주식은 포함하지 않습니다.
GitHub의 과거 실전 주문 workflow는 영구 폐기된 stub입니다. 새 실전 경로는
AWS에서만 동작하며, 최초 배포와 전환은
[AWS 자동투자 runbook](./AWS_AUTOTRADE_RUNBOOK.md)을 순서대로 통과해야 합니다.

AWS 스택을 만드는 것만으로 주문이 시작되지는 않습니다. 기본값은 schedule off,
dry-run, 영구 kill switch on입니다. 실제 주문은 3~5영업일 dry-run과 상태 이전,
실잔고 대조가 끝난 뒤 CloudFormation과 SSM의 독립 잠금을 모두 명시적으로
열어야만 가능합니다.

## 한눈에 보는 구조

```text
매일 저녁
EventBridge Scheduler
  → Step Functions
  → 일회성 ECS Fargate가 DART·금융위원회 데이터 수집
  → 검증된 companies + trading-selection을 같은 S3 revision으로 게시
  → CloudFront manifest가 마지막에 교체됨

평일 장중
EventBridge Scheduler
  → Step Functions
  → 일회성 ECS Fargate가 같은 trading-selection을 읽음
  → DynamoDB 원장·lease·주문 intent 확인
  → KIS 실잔고·당일 시세·매수가능수량 재확인
  → 조건을 모두 통과한 경우에만 제한 주문

장 마감 뒤
서로 분리된 reconcile과 audit 실행
  → 미체결 취소·체결 대조·중복 실행·누락 여부 확인
  → 실패는 CloudWatch/SNS/DLQ로 알림
```

PC가 꺼져 있어도 AWS 수집·판단·주문 대조는 계속됩니다. `127.0.0.1` 웹사이트는
로컬 화면이므로 볼 때만 PC에서 `npm.cmd start`를 실행합니다. 서버는
`REMOTE_ARTIFACT_MANIFEST_URL`에 지정된 CloudFront manifest를 받아 AWS 거래기와
동일한 revision과 checksum의 순위를 표시합니다.

## 웹사이트와 실제 투자 기준

웹의 `자동투자 선정순`과 자동매매는 같은 검증된 `trading-selection.json`을
사용합니다. 웹의 예시 포트폴리오는 100만원 기준이고, 실제 주문은 같은 순위에서
전용계좌의 현재 현금과 보유주식으로 정수 수량을 다시 계산합니다.

- 국내 KOSPI·KOSDAQ만 사용
- 기본 3종목, 정책 허용 범위 3~5종목
- 종목당 최대 35%, 업종당 최대 35%
- 목표 현금 비중 0%
- 최소 포지션 20,000원, 최소 주문 5,000원
- 가치평가·장기성장·기업품질·재무안전과 데이터 신뢰도를 함께 확인
- 적자, 현금흐름 악화, 과도한 부채, 거래정지 같은 가치함정·주문 위험 제외

목표 현금은 0%지만 주식은 1주 단위이며 수수료·종목/업종 상한이 있습니다.
따라서 더는 안전하게 1주를 살 수 없는 소액은 남을 수 있습니다. 미수·신용이나
당일 미확정 매도대금으로 억지로 전액을 맞추지 않습니다.

## 매매 방식

- 최초 배치는 안전 한도 안에서 가용현금을 최대한 사용합니다.
- 전용계좌에 나중에 입금된 현금도 다음 정상 일일 사이클에서 자동 감지합니다.
- 기존 보유종목의 매도·교체는 하루 최대 회전율 20%를 지킵니다.
- 목표가 같고 비중 이탈이 작으면 거래하지 않고 장기 보유합니다.
- 목표에서 빠진 종목은 서로 다른 두 번의 확인 뒤에만 정리합니다.
- 현재가가 KIS가 확인한 당일 영업일과 맞지 않으면 주문하지 않습니다.
- 매수 직전 `미수 없는 매수가능수량`과 kill switch를 다시 확인합니다.
- 시장가가 아닌 제한된 지정가만 사용합니다.
- 수익률 몇 %에 기계적으로 전량 매도하는 단기 익절 규칙은 사용하지 않습니다.

예약 auto는 평일 09:10부터 14:40까지 30분 간격으로 복구 기회를 갖지만, 같은
KST 날짜의 첫 정상 완료 뒤에는 DynamoDB 멱등 기록으로 나머지가 주문 없이
끝납니다. KIS 휴장일 API가 거래 불가를 반환하거나 응답을 검증할 수 없으면
주문하지 않습니다.

## 중복 주문 방지와 상태 보관

- DynamoDB version CAS와 checksum으로 원장 덮어쓰기를 차단
- lease, heartbeat, fencing token으로 동시 실행 차단
- 외부 주문 POST 전에 주문 intent와 현재 원장 version 확인
- 각 주문 결과를 다음 주문 전에 다시 저장
- 응답이 불명확하면 자동 재주문하지 않고 `unknown`으로 동결
- KIS 주문내역과 실잔고로만 미결 상태 해소
- 장 마감 후 서로 다른 조회에서 모두 사라진 주문만 보수적으로 종료
- 같은 날짜·명령의 완료 journal로 Scheduler 중복 호출 차단

S3는 검증된 불변 revision을 먼저 쓰고 `latest/manifest.json`을 마지막에
바꿉니다. 웹사이트와 거래기는 manifest의 byte 수·SHA-256·source revision이
모두 맞아야 새 자료를 사용합니다.

## 비밀값과 전환 상태

KIS와 시장데이터 자격정보의 운영 저장소는 AWS Secrets Manager입니다.
Task definition, S3, DynamoDB, 공개 순위와 로그에는 실제 값을 넣지 않습니다.
GitHub의 기존 암호화 Secret은 최초 AWS seed와 legacy 상태 이전에만 사용하고,
전환 뒤 삭제 또는 회전합니다. 장기 AWS access key는 GitHub에 만들지 않으며
GitHub Actions는 보호 environment의 OIDC 단기 자격증명만 사용합니다.

기존 GitHub 실전 writer가 다시 켜지지 않도록
`AUTOTRADE_LIVE_ENABLED=false`를 유지합니다. AWS와 GitHub 주문 실행기를 동시에
사용하면 안 됩니다.

## 최초 활성화

임의로 일부 단계만 실행하지 말고
[AWS 자동투자 최초 배포·전환 runbook](./AWS_AUTOTRADE_RUNBOOK.md)의 확인란을
사용합니다. 큰 흐름은 다음과 같습니다.

1. AWS 계정 MFA·Budget 준비
2. 정확한 `longview-autotrade` 안전 기본 스택 생성
3. GitHub `aws-production` 보호 environment와 역할 변수 설정
4. 컨테이너 배포와 Secrets Manager seed
5. 데이터 sync·checksum·CloudFront 검증
6. 기존 주문 writer 중지·drain과 원장 이전
7. 3~5영업일 AWS dry-run
8. legacy 데이터 sync 중지와 웹 manifest 전환
9. 실잔고 최종 대조 뒤 live 이중 잠금 해제

## 즉시 중지

1. AWS Systems Manager Parameter Store의 제어 JSON에서
   `killSwitch=true`를 가장 먼저 적용합니다.
2. CloudFormation의 `EnableTradingSchedule=false`로 예약 실행을 끕니다.
3. 실행 중인 Step Functions/ECS 작업과 KIS 미체결 주문을 확인합니다.
4. KIS 앱에서 이미 접수된 주문을 직접 대조합니다.
5. 원인을 해결하고 실잔고·DynamoDB 원장이 일치하기 전에는 잠금을 풀지 않습니다.

## 로컬 확인 명령

```powershell
cd "C:\Users\MSI\OneDrive\바탕 화면\자동투자"
npm.cmd run check
npm.cmd run trade:verify-kis
npm.cmd start
```

- 웹사이트: <http://127.0.0.1:4173>
- `trade:verify-kis`는 인증과 잔고 조회만 하며 주문은 보내지 않습니다.
- 로컬 `.env`는 계속 `paper`로 둘 수 있습니다.
- AWS 운영 상태는 CloudWatch, Step Functions, DynamoDB journal과 KIS 앱을 함께
  확인합니다.

## 중요 한계

이 시스템은 수익이나 무중단 주문을 보장하지 않습니다. 공시·일일 시세 지연,
증권사/API 점검, 거래정지, 상하한가, 부분체결, 수수료·세금과 슬리피지로 결과가
달라집니다. 데이터 또는 주문 결과를 확실히 확인할 수 없을 때는 거래를
추정하지 않고 실패 폐쇄하며, 알림을 받은 운영자의 확인이 필요합니다.
