# Longview

> AWS 자동투자 전환 구조에서 GitHub의 `live-autotrade.yml`은 영구 폐기된
> 안내용 stub이며 주문을 실행하지 않습니다. 최초 AWS 스택 이름은 정확히
> `longview-autotrade`이고, schedule off·dry-run·kill switch true 상태에서
> 시작합니다. 계정 보호부터 명시적인 live 잠금 해제까지의 순서는
> [AWS 최초 배포·전환 runbook](./docs/AWS_AUTOTRADE_RUNBOOK.md)을 따르세요.
> 기존 GitHub `daily-sync.yml`은 AWS 데이터와 CloudFront manifest 전환 검증이
> 끝날 때까지만 legacy 데이터 공급 경로로 유지합니다.

KOSPI·KOSDAQ 상장사를 DART 공시와 금융위원회 일일 시세로 비교하는 가치·장기투자
연구용 스크리너입니다. 종합점수, 저평가·장기성장·기업품질·재무안전 영역, 재무 추이,
평가 근거와 원문 공시를 한 화면에서 확인할 수 있습니다.

모의투자는 연구 사이트와 분리된 `autotrade/` 서비스입니다. 기본 설정은 실제 주문을
보낼 수 없는 모의 모드이며 별도 원장과 4180 포트를 사용합니다. 자세한 내용은
[자동투자 안내](./docs/AUTOTRADE.md)를 확인하세요.

현재 자동투자 정책은 국내 적격 종목만 대상으로 목표 현금을 0%로 두고, 최초 배치와 이후
전용계좌에 추가된 가용현금을 안전 한도 안에서 자동으로 투자합니다. 이후에는 매일 새 평가를 확인하지만 비중 이탈, 더 우수한
후보 또는 연속 확인된 품질 악화가 있을 때만 제한적으로 조정합니다. 1주 단위와 수수료 때문에
다음 주식을 더 살 수 없는 소액은 남을 수 있습니다.

실전 연결에는 한국투자증권 Open API의 App Key·App Secret뿐 아니라 전용계좌 번호와 상품코드,
원화 자본 상한 또는 전용계좌 전체자산 승인, 그리고 실전·무인 실행 잠금 설정이 모두 필요합니다. 키만 입력해 실제 주문이 켜지지는
않으며, 현재 로컬 `.env`도 계속 모의 모드입니다.

## 사이트 켜기

PowerShell에서 아래 세 줄을 실행합니다.

```powershell
cd "C:\Users\MSI\OneDrive\바탕 화면\자동투자"
npm.cmd start
```

브라우저에서 <http://127.0.0.1:4173>을 엽니다. 이 터미널은 사이트를 보는 동안 켜
두어야 하며, 종료할 때는 `Ctrl+C`를 누릅니다. 외부 패키지 설치는 필요 없고 Node.js
20 이상만 있으면 됩니다.

`.env`에 `REMOTE_SNAPSHOT_URL`이 설정되어 있으면 서버는 시작 직후 GitHub의 최신
스냅샷을 확인하고, 켜져 있는 동안 30분마다 변경 여부를 확인합니다. 원격 파일에 다른
지역 데이터가 섞여 있어도 서버는 국내 상장사만 정규화해 사용합니다.

AWS 전환 뒤에는 CloudFormation Output `LatestManifestUrl`을
`REMOTE_ARTIFACT_MANIFEST_URL`에 설정합니다. 서버는 CloudFront manifest가
가리키는 동일 revision의 회사·선정 파일을 checksum 검증 후 함께 사용합니다.

전체 검사는 다음 명령입니다.

```powershell
npm.cmd run check
```

## 국내 전체시장 갱신

`.env`에 DART 키를 넣은 뒤 다음 명령을 실행하면 KOSPI·KOSDAQ 전체 목록과 공시를
갱신합니다.

```powershell
npm.cmd run sync
```

최초 실행은 상장 법인의 시장 구분과 재무를 확인하므로 오래 걸릴 수 있습니다. 진행
상태를 `data/dart-market/`에 저장하므로 중간에 끊겨도 같은 명령으로 이어집니다.

필요한 개별 명령은 다음과 같습니다.

- `npm.cmd run sync:kr-market`: DART 전체시장 수집
- `npm.cmd run sync:prices`: 금융위원회 일일 시세 수집
- `npm.cmd run sync:daily`: 공시·시세 전체 일일 갱신
- `npm.cmd run validate:snapshot`: 공개 스냅샷 검증

한국 시세는 금융위원회 [주식시세정보](https://www.data.go.kr/data/15094808/openapi.do)를
사용합니다. 무료 공식 데이터이며 실시간 호가가 아니라 기준일 다음 영업일 오후 1시
이후 제공되는 일일 종가입니다. 화면에는 가격 기준일과 공급자를 함께 표시합니다.

가격 공급이 잠시 실패하면 마지막 정상 가격을 보존하고 상태를 표시합니다. 10일을 넘긴
가격은 정상 커버리지에 포함하지 않습니다. PER·PBR·PSR·FCF 수익률은 같은 기준의 공시
재무와 시세가 모두 검증될 때만 계산하며, 값이 없을 때 임의로 0점을 만들지 않습니다.

## GitHub 매일 자동갱신

[daily-sync.yml](./.github/workflows/daily-sync.yml)은 매일 19:35·22:35·다음 날 01:35 KST에
동일한 갱신을 재시도합니다. GitHub 예약 지연이나 일시 장애가 있어도 후속 실행이 보완하며,
성공한 수집은 웹사이트 순위와 자동투자 선택 파일을 한 쌍으로 검증해 게시합니다.

1. 코드와 점수 테스트
2. DART KOSPI·KOSDAQ 전체시장 갱신
3. 금융위원회 일일 종가 갱신
4. 기업 수·시세 커버리지·중복 ID 검증
5. 성공한 `data/companies.json`과 동일 기준의 `data/trading-selection.json`만 자동 커밋

GitHub에서 처음 한 번만 설정합니다.

1. 저장소 **Settings → Secrets and variables → Actions**에 `DART_API_KEY`와
   `DATA_GO_KR_API_KEY`를 등록합니다.
2. **Settings → Actions → General → Workflow permissions**에서 **Read and write**를
   허용합니다.
3. **Actions → Daily Korean market sync → Run workflow**를 한 번 실행합니다.

로컬 `.env`에는 다음 raw 주소를 사용할 수 있습니다.

```dotenv
REMOTE_SNAPSHOT_URL=https://raw.githubusercontent.com/gokyunghwan-prog/longview-invest/main/data/companies.json
```

인터넷이 잠시 끊기면 마지막 정상 `.cache/companies.json`을 계속 제공합니다. GitHub
Actions는 데이터 갱신 작업자이며 공개 웹 서버는 아닙니다. 다른 사람도 접속하는 사이트가
필요하면 Node 서버를 별도 호스팅해야 합니다.

## 포함 기준과 점수

- Open DART `corpCode.xml`에 종목코드가 있고 기업개황의 시장 구분이 KOSPI 또는
  KOSDAQ인 현재 상장 법인을 포함합니다.
- KONEX와 비상장 법인은 제외합니다.
- 재무가 부족한 신규 기업은 목록에서 없애지 않고 `데이터 부족`으로 표시합니다.
- 금융·보험·REIT·펀드·SPAC처럼 일반회사 모델이 맞지 않는 기업은 순위 평가를
  보류하고 이유를 공개합니다.

일반 비금융회사 v2 점수는 저평가 30점, 장기성장 35점, 기업품질 20점, 재무안전
15점입니다. 현재 가격이 재무가치보다 낮은지와 재무가 장기간 개선됐는지를 함께 보며,
결측 배점을 다른 지표에 몰아주지 않습니다. 기본 추천순은 후보 안전조건을 통과한 회사를
먼저 두고 같은 상태 안에서 점수순으로 정렬합니다.

장기 검토 후보는 점수·신뢰도·완전성·재무 이력·가치평가·위험 조건을 모두 통과해야
합니다. 적자, 장기 매출·이익 동반 감소, 음수 FCF, 과도한 부채 같은 가치함정 신호가
있으면 총점이 높아도 후보에서 제외합니다.

## API 구조

- `GET /api/overview`: 전체 수, 후보 수, 평균점수, 산업 분류
- `GET /api/companies?...&page=1&pageSize=25`: 검색·필터·정렬된 한 페이지
- `GET /api/companies/:id`: 선택한 회사의 전체 공시·위험·계보

브라우저에는 기본 25개 카드만 전송하고, 상세 데이터는 회사를 선택할 때만 요청합니다.
서버는 스냅샷 파일이 교체되면 원자적으로 다시 읽으며 파싱 실패 시 마지막 정상 데이터를
계속 제공합니다.

## 환경변수

[.env.example](./.env.example)을 참고합니다. `.env`는 Git에서 제외되며 비밀키는
브라우저로 전달되지 않습니다.

- `DART_API_KEY`: Open DART 인증키
- `DATA_GO_KR_API_KEY`: 금융위원회 주식시세정보 일반 인증키(Decoding)
- `REMOTE_SNAPSHOT_URL`: GitHub가 갱신한 공개 스냅샷 주소(선택)
- `REMOTE_ARTIFACT_MANIFEST_URL`: AWS CloudFront의 `latest/manifest.json`
  주소(AWS 전환 뒤 사용)
- `ENABLE_SCHEDULER`: 이 컴퓨터에서 직접 예약 수집할 때만 사용
- `SCHEDULE_HOUR_KST`: 로컬 예약 수집 시각
- `SYNC_TOKEN`: 보호된 `POST /api/sync`를 사용할 때만 설정

## 구현 명세와 공식 문서

- [국내 전체시장 구현 프롬프트](./docs/FULL_MARKET_PROMPT.md)
- [일일 시세·가치평가 구현 프롬프트](./docs/STOCK_PRICE_PROMPT.md)
- [제품·점수 마스터 프롬프트](./docs/MASTER_PROMPT.md)
- [국내 가치·장기 자동투자 구현 프롬프트](./docs/DOMESTIC_AUTOTRADE_PROMPT.md)
- [자동 현금 투입·예약 복구 디버깅 프롬프트](./docs/AUTOMATIC_CASH_DEPLOYMENT_DEBUG_PROMPT.md)
- [AWS 자동투자 최초 배포·전환 runbook](./docs/AWS_AUTOTRADE_RUNBOOK.md)
- [AWS 자동투자 인프라 설명](./infra/aws/README.md)
- [Open DART 공시검색](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)
- [Open DART 기업개황](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002)
- [Open DART 다중회사 주요계정](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019017)
- [금융위원회 주식시세정보 API](https://www.data.go.kr/data/15094808/openapi.do)
- [GitHub Actions 예약 실행](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## 면책

이 서비스는 공개 공시자료를 정해진 규칙으로 분석한 정보·교육용 연구 도구입니다.
매수·매도·보유 권유나 미래 수익 보장이 아니며, 투자 결정 전 반드시 원문 공시를
확인하세요.
