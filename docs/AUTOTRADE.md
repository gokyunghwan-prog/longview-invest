# Longview 국내 자동투자 운영 안내

이 문서는 현재 구현된 구조의 기준 문서입니다. 자동매매는 한국투자증권(KIS) 국내주식 전용이며 미국주식은 포함하지 않습니다.

## 한눈에 보는 구조

```text
매일 19:35 KST
GitHub Actions가 DART·금융위원회 데이터를 갱신
  → data/companies.json
  → 같은 판단 기준으로 data/trading-selection.json 생성

평일 09:23 KST
GitHub Actions가 공개 순위 안에서 현재 계좌자금으로 가능한 상위 종목을 KIS 실전계좌에 리밸런싱

평일 15:13 KST
주문·체결을 다시 대조하고, 안전하게 확인된 전량 미체결 주문만 취소

로컬 웹사이트
GitHub의 두 공개 파일을 함께 받아 최신 순위와 자동투자 목표를 표시
```

따라서 PC가 꺼져 있어도 데이터와 목표 순위, 자동매매 작업은 GitHub에서 진행됩니다. 다만 `127.0.0.1` 웹사이트 자체는 로컬 서버이므로 화면을 볼 때는 PC에서 `npm.cmd start`를 실행해야 합니다.

## 웹사이트와 실제 투자 기준

웹의 기본 정렬인 `자동투자 선정순`과 자동매매는 같은 `trading-selection.json`의 검증된 전체 순위를 사용합니다. 웹에는 100만원 기준 예시 포트폴리오를 표시하고, 실제 주문은 같은 순위 안에서 전용계좌의 현재 자금으로 살 수 있는 상위 종목을 다시 계산합니다.

- 국내 KOSPI·KOSDAQ만 사용
- 웹 공개 예시 투자금 1,000,000원
- 기본 3종목, 정책 허용 범위 3~5종목
- 종목당 최대 35%, 업종당 최대 35%
- 목표 현금 비중 0%
- 최소 포지션 20,000원, 최소 주문 5,000원
- 종합점수 78, 신뢰도 85, 완전성 85, 가치평가 신뢰도 75 이상
- 시가총액 1,000억원, 최근 일 거래대금 5억원 이상
- 현재 가치가 상대적으로 낮고 장기 성장·품질·재무안전성이 함께 확인되는 회사를 우선

목표 현금은 0%지만 국내주식은 1주 단위이고 수수료·종목/업종 상한이 있으므로 몇 천~몇 만원의 잔액이 불가피하게 남을 수 있습니다. 미수나 신용으로 억지로 전액을 맞추지 않습니다.

## 매매 방식

- 최초 배치는 허용 투자금의 최대 100%까지 사용합니다.
- 현재 실전 워크플로는 자동매매 전용계좌의 전체 관리자산을 기준으로 하며, 평가이익과 매매 후 현금도 다음 리밸런싱에 다시 포함합니다.
- 이후 하루 최대 회전율은 20%입니다.
- 공개 목표가 바뀌지 않고 비중 이탈이 작으면 그대로 보유합니다.
- 목표에서 빠진 종목은 두 번 연속 확인한 뒤 정리합니다.
- 현재가가 당일 KIS 영업일과 일치하지 않으면 주문하지 않습니다.
- 실전 주문은 평일 09:05~14:50 KST에만 허용합니다.
- 거래시간은 GitHub 러너의 시스템 시각이 아니라 GitHub API의 HTTPS `Date`를 보수적인 범위로 검증하며, 시각 확인 실패·지연·불일치 시 주문 없이 중단합니다.
- 매수 직전에 KIS의 `미수 없는 매수가능수량`을 다시 확인합니다.
- 시장가가 아닌 보수적 지정가만 사용합니다.
- 수익률 몇 % 도달 시 무조건 매도하는 단기 익절 규칙은 사용하지 않습니다. 가치·장기 순위와 목표비중 변화로만 조정합니다.
- 같은 날 추가 입금액을 즉시 배치할 때는 GitHub Actions의 확인된 `topup` 실행만 사용합니다. 이 경로는 고유 실행번호당 한 번만 처리하고 매도 없이 가용현금 범위의 매수만 허용합니다.

## 중복 주문 방지와 상태 보관

GitHub 러너는 실행할 때마다 사라지므로 상태를 일반 파일이나 Actions 캐시에 두지 않습니다.

- 별도 `trade-state` 브랜치의 `state.enc`에 AES-256-GCM으로 암호화해 저장
- GitHub blob SHA 비교(CAS), 원격 lease와 fence로 동시 실행 차단
- 주문 의도를 외부 주문 전에 먼저 저장
- 각 주문 결과를 다음 주문 전에 다시 저장
- 결과가 불명확하면 재주문하지 않고 `unknown`으로 차단
- KIS 주문내역을 최대 7일 범위에서 대조
- 장 마감 후 서로 다른 두 번의 확인에도 주문이 없을 때만 `not_found` 처리

공개 저장소에는 암호문만 올라갑니다. 계좌 잔고, 보유수량, 주문번호, API 키는 공개 순위 파일에 들어갈 수 없도록 검증합니다.

## GitHub에 필요한 비밀값

저장소의 `Settings → Secrets and variables → Actions`에 아래 값을 등록합니다.

- `DART_API_KEY`
- `DATA_GO_KR_API_KEY`
- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `KIS_ACCOUNT_NUMBER`
- `KIS_ACCOUNT_PRODUCT_CODE` (보통 `01`)
- `KIS_HTS_ID` (선택)
- `AUTOTRADE_STATE_KEY` (정확히 32바이트인 표준 Base64 키)
- `LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING_RISK`
- `USE_ALL_DEDICATED_ACCOUNT_ASSETS_ACK=I_ACCEPT_USING_ALL_DEDICATED_ACCOUNT_ASSETS`
- `UNATTENDED_LIVE_TRADING_ACK=I_ACCEPT_UNATTENDED_LIVE_TRADING_RISK`
- `CLOUD_LIVE_TRADING_ACK=I_ACCEPT_GITHUB_ACTIONS_LIVE_TRADING`

API 키와 계좌번호는 커밋하지 않습니다. 로컬 `.env`와 GitHub Actions 암호화 Secrets에만 둡니다.

실전 워크플로의 `TRADING_CAPITAL_LIMIT_KRW=0`은 무제한 신용을 뜻하지 않습니다. 미수·신용은 사용하지 않고, KIS가 확인한 전용계좌의 실제 현금과 이 시스템이 관리하는 보유주식만 전부 다시 배분한다는 뜻입니다. 이 모드는 `TRADING_REQUIRE_DEDICATED_ACCOUNT=true`, `TRADING_USE_ALL_DEDICATED_ACCOUNT_ASSETS=true`, 위 전체자산 승인문구가 모두 정확히 일치할 때만 시작됩니다. 원화 상한을 두고 싶으면 `TRADING_CAPITAL_LIMIT_KRW`를 양수로 설정할 수 있습니다.

저장소 변수에는 다음 값이 있습니다.

- `AUTOTRADE_LIVE_ENABLED=false`: 기본값, 예약 실전매매 중지
- `AUTOTRADE_LIVE_ENABLED=true`: 검증 완료 뒤 예약 실전매매 허용

## 처음 활성화하는 순서

1. 코드를 기본 브랜치에 반영합니다.
2. 위 Secrets를 등록하고 `AUTOTRADE_LIVE_ENABLED=false`로 둡니다.
3. `Actions → Encrypted Korean live autotrade → Run workflow`에서 기본값 `plan`, `confirm_live=false`로 실행합니다.
4. 로그에서 테스트·공개선정·KIS 읽기전용 계획이 정상인지 확인합니다. 이 단계는 주문하지 않습니다.
5. 별도 KIS 앱에서 계좌가 자동투자 전용이며 다른 보유주식이 없는지 확인합니다. 전체자산 모드에서는 이후 이 계좌에 추가한 현금과 발생한 수익도 자동투자 대상이 됩니다.
6. 마지막으로 저장소 변수만 `AUTOTRADE_LIVE_ENABLED=true`로 바꿉니다.

GitHub 예약 실행은 정확한 초 단위 보장이 없고 혼잡하면 늦어질 수 있습니다. 코드가 주문시간, 당일 시세, 상태 SHA를 다시 검사하므로 늦어진 실행은 주문하지 않고 닫힙니다.

## 즉시 중지

가장 빠른 방법은 GitHub 저장소의 `AUTOTRADE_LIVE_ENABLED` 변수를 `false`로 바꾸고, 실행 중인 Actions 작업이 있으면 `Cancel workflow`를 누르는 것입니다. 이미 증권사에 접수된 주문은 KIS 앱에서 직접 확인해야 합니다.

## 로컬 확인 명령

```powershell
cd "C:\Users\MSI\OneDrive\바탕 화면\자동투자"
npm.cmd run check
npm.cmd run trade:verify-kis
npm.cmd start
```

- 웹사이트: <http://127.0.0.1:4173>
- `trade:verify-kis`는 인증과 잔고 조회만 하며 주문은 0건입니다.
- 로컬 `.env`는 계속 `paper`로 두어도 GitHub 실전 워크플로에는 영향이 없습니다.

## 중요 한계

이 시스템은 수익을 보장하지 않습니다. 공시·재무·시세 지연, API 장애, 거래정지, 상하한가, 수수료와 세금, 슬리피지로 실제 결과가 달라질 수 있습니다. 자동화는 판단과 주문을 반복할 뿐 미래 가격을 알 수 없습니다.
