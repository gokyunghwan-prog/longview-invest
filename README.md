# Longview

한국 KOSPI·KOSDAQ과 SEC가 Nasdaq·NYSE·CBOE로 매핑한 미국 상장 등록기업을 공식
공시로 비교하는 장기투자 연구용 스크리너입니다. 점수, 영역별 막대, 재무 추이,
평가 근거, 데이터 완전성, 최근 공시 원문과 연결된 일일 시세를 함께 보여줍니다.

## 지금 사이트 켜기

PowerShell에서 이 프로젝트 폴더로 이동한 뒤 실행합니다.

~~~powershell
npm.cmd start
~~~

브라우저에서 <http://127.0.0.1:4173>을 엽니다. 외부 패키지 설치는 필요 없고
Node.js 20 이상만 있으면 됩니다. `.env`에 `REMOTE_SNAPSHOT_URL`이 있으면 서버는
시작 직후 GitHub의 최신 데이터를 확인하고, 이후 30분마다 변경 여부만 다시 확인합니다.

코드를 검사하려면 다음 한 줄만 실행합니다.

~~~powershell
npm.cmd run check
~~~

## 전체시장 데이터 갱신

### 한국: 이 컴퓨터에서 가능

`.env`에 넣어 둔 DART 키로 다음을 실행하면 KOSPI·KOSDAQ 전체 목록을 갱신합니다.

~~~powershell
npm.cmd run sync
~~~

최초 한 번은 stock_code가 있는 모든 법인의 시장 구분을 공식 기업개황으로 확인하므로
수천 회의 API 요청과 수십 분이 걸릴 수 있습니다. 25개 회사마다 체크포인트를 저장해
중간에 끊겨도 같은 명령으로 이어서 실행됩니다. 두 번째부터는 변경 기업과 최근 공시만
재확인하고, 재무는 100개씩 묶어 받아 훨씬 빨라집니다.

한국 수집 결과만 따로 만들 때는 `npm.cmd run sync:kr-market`, 최종 한국·미국 파일을
다시 합칠 때는 `npm.cmd run merge:markets`를 사용합니다.

### 시세: 한국 무료 공개 + 미국은 재배포 권한이 있을 때만

한국은 금융위원회 [주식시세정보](https://www.data.go.kr/data/15094808/openapi.do)를
사용합니다. 무료이고 KOSPI·KOSDAQ 종가·등락률·거래량·시가총액을 제공하지만
`실시간`은 아니며 **기준일 다음 영업일 오후 1시 이후(T+1)** 갱신됩니다.

미국은 무료 개인용 전체시장 API가 가격 원자료와 파생값의 GitHub 전송·공개 재배포를
허용하지 않습니다. 따라서 약관을 우회하는 스크래핑이나 암호문 커밋은 하지 않습니다.
미국 가격은 외부배포 권리를 실제로 보유한 `licensed snapshot`을 연결했을 때만 표시하고,
그 전에는 SEC 공시에서 가져온 재무·현금흐름 보강값만 제공하며 가격은 `N/A`로 둡니다.

licensed snapshot은 아래처럼 `schemaVersion: 1`, 하나의 가격 기준일, 공개권리 검토 정보를
명시해야 합니다. URL·라이선스 문서 host는 모두 `US_LICENSED_PRICE_ALLOWED_HOSTS`에
등록해야 하며, 실제 권리 확인 책임은 운영자에게 있습니다.

~~~json
{
  "schemaVersion": 1,
  "asOf": "2026-07-17",
  "manifest": {
    "usageMode": "public",
    "redistributionAllowed": true,
    "derivedPublicationAllowed": true,
    "provider": "Licensed provider",
    "sourceUrl": "https://prices.example.com/source",
    "licenseReference": "https://legal.example.com/market-data-license",
    "licenseId": "contract-2026-001",
    "rightsReviewedAt": "2026-07-01",
    "marketCapScope": "issuer"
  },
  "data": [
    {
      "ticker": "AAPL",
      "exchange": "Nasdaq",
      "currency": "USD",
      "close": 210.5,
      "marketCap": 3140000000000
    }
  ]
}
~~~

키를 넣은 뒤 시세만 수동 확인할 때는 다음 한 줄입니다.

~~~powershell
npm.cmd run sync:prices
~~~

키가 없거나 공급자가 잠시 실패해도 마지막 정상 시세를 보존하되 `보존` 또는 `stale`로
명확히 표시합니다. 10일을 넘긴 가격은 정상 커버리지에 포함하지 않습니다.
GitHub에서는 설정된 가격 공급자가 실패해도 새 공시 스냅샷은 먼저 보존·push하고, 마지막
검증 단계가 실패로 표시되어 Actions 화면에서 가격 오류를 놓치지 않게 합니다.
PER·PBR·PSR·FCF 수익률은 같은 통화의 연차 공시 원금액과 시세가 모두 있을 때만 계산하며
검증을 통과한 값은 v2 저평가 영역과 총점에 반영합니다. 필요한 가치지표가 없으면 임의의
0점을 만들지 않고 해당 기업의 가치 순위 평가를 보류합니다.

### 미국: GitHub Actions에서 처리

미국 전체시장은 회사별 API를 수천 번 호출하지 않습니다. SEC가 매일 밤 다시 만드는
`companyfacts.zip`과 `submissions.zip`을 GitHub Actions가 한 번씩 내려받아 필요한
CIK와 재무 항목만 남깁니다. 원본 ZIP은 처리 직후 삭제합니다.

[daily-sync.yml](./.github/workflows/daily-sync.yml)은 매일 19:35 KST에 다음을 수행합니다.

1. 코드와 점수 테스트
2. DART KOSPI·KOSDAQ 전체시장 갱신
3. SEC Nasdaq·NYSE·CBOE 전체시장 벌크 갱신
4. 한국 공식 T+1 시세와 설정된 재배포 허용 미국 시세 갱신
5. 기업 수·시세 커버리지 급감, 중복 ID, 데모 혼입, SEC 추출 누락을 배포 전에 검증
6. 어느 한쪽이라도 실패하면 마지막 정상 스냅샷을 보존
7. 재배포가 허용된 공개 `data/companies.json`만 자동 커밋

GitHub에서 처음 한 번만 설정할 항목은 다음과 같습니다.

1. 이 폴더를 GitHub 저장소에 올립니다.
2. 저장소 **Settings → Secrets and variables → Actions**에 `DART_API_KEY`와
   `SEC_USER_AGENT`를 등록합니다. SEC 값은 `Longview Screener 실제연락이메일` 형식입니다.
3. 한국 시세를 켜려면 `DATA_GO_KR_API_KEY`를 추가합니다. 미국 가격은 별도 재배포
   계약이 있을 때만 `US_LICENSED_PRICE_SNAPSHOT_*` 항목을 설정합니다.
4. **Settings → Actions → General → Workflow permissions**에서 Read and write를 허용합니다.
5. **Actions → Daily full-market disclosure sync → Run workflow**를 한 번 실행합니다.

공개 저장소는 60일간 활동이 없으면 GitHub가 예약 작업을 자동 중지할 수 있습니다.
Actions 화면에서 다시 활성화할 수 있습니다.

### GitHub의 전체 데이터를 이 로컬 화면에 받기

공개 저장소를 만든 뒤 `.env`에 아래 raw 주소를 한 번만 추가합니다.

~~~dotenv
REMOTE_SNAPSHOT_URL=https://raw.githubusercontent.com/사용자명/저장소명/main/data/companies.json
~~~

이후에는 `npm.cmd start`만 실행하면 됩니다. 서버가 시작 직후 최신 GitHub snapshot을
`.cache/companies.json`에 안전하게 받고, 켜져 있는 동안 30분마다 ETag로 변경 여부를
확인합니다. GitHub 데이터가 바뀌면 서버와 열어 둔 화면이 자동으로 새 revision을 읽습니다.
인터넷이 잠시 끊겨도 마지막 정상 cache를 계속 사용하며, Git이 추적하는
`data/companies.json`은 수정하지 않습니다. GitHub 저장소가 비공개라면 raw 주소 대신
별도 배포 서버나 인증된 객체 저장소가 필요합니다.

`REMOTE_SNAPSHOT_URL`을 사용하지 않고 이 노트북 CPU로 직접 전체시장을 수집할 때만
`ENABLE_SCHEDULER=true`와 `SCHEDULE_HOUR_KST`를 설정합니다.

GitHub Actions의 첫 성공 실행 전에는 미국 회사 수가 0으로 표시됩니다. 실제 공시가
아닌 예시 회사를 전체시장 목록에 섞어 보여주지는 않습니다.

## 실제 포함 기준

- 한국: Open DART `corpCode.xml`에 stock_code가 있고 `company.json`의 corp_cls가
  Y(KOSPI) 또는 K(KOSDAQ)인 현재 법인
- 미국: SEC `company_tickers_exchange.json`의 exchange가 Nasdaq, NYSE 또는 CBOE인
  등록자. 같은 CIK의 여러 ticker·주식종류는 한 회사로 통합
- KONEX, OTC, 거래소가 없는 SEC 등록자는 제외
- 재무가 부족한 신규사·외국기업도 목록에서 삭제하지 않고 `DATA 부족`으로 표시
- 금융·보험·REIT·펀드·SPAC은 일반회사 점수가 왜곡될 수 있어 `평가 보류`로 표시하고
  장기 검토 후보에서 제외

SEC와 DART의 매핑은 법적 상장 효력일 원장 자체는 아닙니다. 따라서 화면은 공식 원천이
현재 제공한 분류 범위를 뜻하며, 정확한 상장·상폐 효력일을 임의로 주장하지 않습니다.

## 점수 해석

일반 비금융회사 v2 모델은 **현재 가격이 재무가치에 비해 낮은지**와 **그 재무가 장기간
개선돼 왔는지**를 함께 봅니다.

- 저평가 30점: PER 12, PBR 8, PSR 6, FCF 수익률 4
- 장기성장 35점: 매출 CAGR 10, 최근 매출 성장 5, 영업이익 성장 5,
  영업이익률 추세 5, 매출 안정성 5, 흑자 지속 5
- 기업품질 20점: ROE 7, 영업이익률 5, 순이익률 3, FCF 마진 3, 현금 전환율 2
- 재무안전 15점: 부채비율 9, 유동비율 6

저평가는 절대 구간과 같은 국가·업종 내 상대 수준을 50:50으로 결합합니다. 업종 표본이
10개보다 적으면 20개 이상인 국가 표본으로 보완하고, 국가 표본도 부족하면 검증된
절대구간만 사용합니다. 없는 값의 배점을 다른 지표에 몰아주지 않으며, 검증된 가치지표가
부족하면 가치 순위 평가를 보류합니다.

장기 검토 후보는 점수 75 이상, 신뢰도 80 이상, 완전성 80% 이상, 3개년 이력,
실제 공시, 검증된 가치평가, 중대 위험 없음 조건을 모두 만족해야 합니다. 국내
현금흐름은 DART 전체 재무제표의 연간 영업현금흐름과 PPE 취득액이 같은 연결 기준에서
모두 확인될 때만 증분 체크포인트로 보강합니다.

후보 안전선은 저평가 60, 장기성장 55, 기업품질 55, 재무안전 45점입니다. 확인 가능한
연간 ROE는 5% 이상, 매출 안정성은 40 이상이어야 하며, 영업·순이익 적자, 장기 매출·이익
동반 감소, 음수 FCF, 과도한 부채, 영업이익보다 비정상적으로 큰 순이익 같은 가치함정
신호가 있으면 총점이 높아도 후보에서 제외합니다. 일반 정정 공시는 위험에 표시하되
재무 재작성과 무관할 수 있어 횟수만으로 자동 탈락시키지 않습니다.

분기 공시가 더 최신이어도 가치·품질·안전·성장 점수는 가치지표와 기간이 맞는 연차
재무를 우선합니다. 이 때문에 단기 실적 급등이 장기 점수를 과도하게 끌어올리지 않습니다.

기본 추천순은 이 후보 안전조건을 통과한 기업을 먼저 두고, 같은 상태 안에서 점수순으로
정렬합니다. 화면의 평균점수와 평균 신뢰도는 가치평가가 가능한 기업만 계산합니다.

DART와 SEC 자체에는 현재 주가가 없으므로 별도 시세의 기준일과 출처를 함께 표시합니다.
검증된 PER·PBR·PSR·FCF 수익률은 저평가 영역에 반영하고, 누락된 값은 0점으로 바꾸지
않습니다. 재무 이력과 비율은 장기 성장 가능성을 비교하기 위한 대용치이며 실제 주가
상승을 예측하거나 보장하지 않습니다.

## 대규모 화면 구조

- `GET /api/overview`: 전체 수, 후보 수, 평균점수, 국가·산업 분류
- `GET /api/companies?...&page=1&pageSize=25`: 검색·필터·정렬된 한 페이지
- `GET /api/companies/:id`: 클릭한 회사의 전체 공시·위험·계보

서버는 스냅샷을 메모리에 한 번만 읽고 파일이 교체되면 자동으로 다시 로드합니다.
브라우저는 기본 25개 카드만 만들기 때문에 수천 개 회사에서도 전체 JSON과 DOM을
한꺼번에 처리하지 않습니다. 열어 둔 화면도 5분마다 revision을 확인해 새 데이터가
있을 때 현재 필터를 유지한 채 자동 갱신합니다.

GitHub Actions는 데이터 수집 작업자이지 웹 서버가 아닙니다. 다른 사람도 접속하는
공개 사이트로 운영하려면 이 Node 서버를 Render, Fly.io, VM 같은 실행형 호스팅에
별도로 배포해야 합니다.

## 환경변수

[.env.example](./.env.example)을 참고합니다. `.env`는 Git에서 제외되며 DART 키와
SEC 연락정보는 브라우저로 전달되지 않습니다.

- `DART_API_KEY`: Open DART 인증키
- `SEC_USER_AGENT`: 서비스명과 실제 연락 이메일
- `DATA_GO_KR_API_KEY`: 금융위원회 주식시세정보 일반 인증키(Decoding)
- `US_LICENSED_PRICE_SNAPSHOT_URL`: 공개 재배포 권리가 있는 미국 시세 JSON(선택)
- `US_LICENSED_PRICE_SNAPSHOT_TOKEN`: 위 snapshot 인증 토큰(선택)
- `US_LICENSED_PRICE_ALLOWED_HOSTS`: 운영자가 승인한 snapshot host 목록(쉼표 구분)
- `REMOTE_SNAPSHOT_URL`: GitHub Actions가 커밋한 공개 snapshot raw 주소(선택)
- `ENABLE_SCHEDULER`: 원격 snapshot 없이 이 컴퓨터에서 직접 전체수집할 때만 사용
- `SCHEDULE_HOUR_KST`: 위 로컬 전체수집 시각
- `SYNC_TOKEN`: 보호된 `POST /api/sync`를 사용할 때만 설정

## 구현 명세와 공식 문서

- [전체시장 구현 프롬프트 v2](./docs/FULL_MARKET_PROMPT.md)
- [일일 시세·가치평가 보강 구현 프롬프트 v1](./docs/STOCK_PRICE_PROMPT.md)
- [기존 제품·점수 마스터 프롬프트](./docs/MASTER_PROMPT.md)
- [Open DART 공시검색](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)
- [Open DART 기업개황](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002)
- [Open DART 다중회사 주요계정](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019017)
- [Open DART 다중회사 재무지표](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2022002)
- [SEC EDGAR API와 야간 bulk 파일](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [금융위원회 주식시세정보 API](https://www.data.go.kr/data/15094808/openapi.do)
- [GitHub Actions 예약 실행](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## 면책

이 서비스는 공개 공시자료를 정해진 규칙으로 분석한 정보·교육용 연구 도구입니다.
매수·매도·보유 권유나 미래 수익 보장이 아니며, 공시에는 지연·오류·사후 정정이 있을
수 있습니다. 투자 결정 전 반드시 원문 공시를 확인하세요.
