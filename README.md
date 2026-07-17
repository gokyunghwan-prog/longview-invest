# Longview

한국 KOSPI·KOSDAQ과 SEC가 Nasdaq·NYSE·CBOE로 매핑한 미국 상장 등록기업을 공식
공시로 비교하는 장기투자 연구용 스크리너입니다. 점수, 영역별 막대, 재무 추이,
평가 근거, 데이터 완전성, 최근 공시 원문을 함께 보여줍니다.

## 지금 사이트 켜기

PowerShell에서 이 프로젝트 폴더로 이동한 뒤 실행합니다.

~~~powershell
npm.cmd start
~~~

브라우저에서 <http://127.0.0.1:4173>을 엽니다. 외부 패키지 설치는 필요 없고
Node.js 20 이상만 있으면 됩니다.

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

### 미국: GitHub Actions에서 처리

미국 전체시장은 회사별 API를 수천 번 호출하지 않습니다. SEC가 매일 밤 다시 만드는
`companyfacts.zip`과 `submissions.zip`을 GitHub Actions가 한 번씩 내려받아 필요한
CIK와 재무 항목만 남깁니다. 원본 ZIP은 처리 직후 삭제합니다.

[daily-sync.yml](./.github/workflows/daily-sync.yml)은 매일 19:35 KST에 다음을 수행합니다.

1. 코드와 점수 테스트
2. DART KOSPI·KOSDAQ 전체시장 갱신
3. SEC Nasdaq·NYSE·CBOE 전체시장 벌크 갱신
4. 기업 수 급감·중복 ID·데모 혼입·SEC 추출 누락을 배포 전에 검증
5. 어느 한쪽이라도 실패하면 새 파일을 커밋하지 않고 마지막 공개 스냅샷을 보존
6. 검증을 통과한 `data/companies.json`만 자동 커밋

GitHub에서 처음 한 번만 설정할 항목은 다음과 같습니다.

1. 이 폴더를 GitHub 저장소에 올립니다.
2. 저장소 **Settings → Secrets and variables → Actions**에 `DART_API_KEY`와
   `SEC_USER_AGENT`를 등록합니다. SEC 값은 `Longview Screener 실제연락이메일` 형식입니다.
3. **Settings → Actions → General → Workflow permissions**에서 Read and write를 허용합니다.
4. **Actions → Daily full-market disclosure sync → Run workflow**를 한 번 실행합니다.

공개 저장소는 60일간 활동이 없으면 GitHub가 예약 작업을 자동 중지할 수 있습니다.
Actions 화면에서 다시 활성화할 수 있습니다.

### GitHub의 미국 데이터를 이 로컬 화면에 받기

GitHub Actions가 갱신해도 이 컴퓨터의 파일이 저절로 바뀌지는 않습니다. 공개 저장소를
만든 뒤 `.env`에 아래 raw 주소를 추가하면 로컬 일일 스케줄러가 최신 미국 스냅샷을
받아 국내 데이터와 병합합니다.

~~~dotenv
REMOTE_SNAPSHOT_URL=https://raw.githubusercontent.com/사용자명/저장소명/main/data/companies.json
ENABLE_SCHEDULER=true
SCHEDULE_HOUR_KST=21
~~~

사이트가 켜져 있으면 매일 21시 KST에 자동 갱신합니다. 수동으로 바로 확인하려면
`npm.cmd run sync`를 한 번 실행하면 됩니다. GitHub 저장소가 비공개라면 raw 주소 대신
배포 서버나 인증된 객체 저장소가 필요합니다.

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

일반 비금융회사 모델은 수익성 25, 성장성 20, 안정성 20, 현금흐름 20, 지속성 10,
공시신뢰 5점입니다. 없는 값의 배점을 다른 지표에 몰아주지 않고 종합점수를 50점으로
수렴시키며 완전성을 낮춥니다.

장기 검토 후보는 점수 75 이상, 신뢰도 80 이상, 완전성 80% 이상, 3개년 이력,
실제 공시, 중대 위험 없음 조건을 모두 만족해야 합니다. DART 다중회사 API에는
현금흐름표가 없으므로 국내 전체시장 최초 목록의 FCF 항목은 결측으로 남습니다.

DART와 SEC는 현재 주가를 제공하지 않으므로 PER·PBR은 대시로 표시하고 점수에 넣지
않습니다. 현재가 공급원을 연결하기 전에는 가격 매력을 추정하지 않습니다.

## 대규모 화면 구조

- `GET /api/overview`: 전체 수, 후보 수, 평균점수, 국가·산업 분류
- `GET /api/companies?...&page=1&pageSize=25`: 검색·필터·정렬된 한 페이지
- `GET /api/companies/:id`: 클릭한 회사의 전체 공시·위험·계보

서버는 스냅샷을 메모리에 한 번만 읽고 파일이 교체되면 자동으로 다시 로드합니다.
브라우저는 기본 25개 카드만 만들기 때문에 수천 개 회사에서도 전체 JSON과 DOM을
한꺼번에 처리하지 않습니다.

GitHub Actions는 데이터 수집 작업자이지 웹 서버가 아닙니다. 다른 사람도 접속하는
공개 사이트로 운영하려면 이 Node 서버를 Render, Fly.io, VM 같은 실행형 호스팅에
별도로 배포해야 합니다.

## 환경변수

[.env.example](./.env.example)을 참고합니다. `.env`는 Git에서 제외되며 DART 키와
SEC 연락정보는 브라우저로 전달되지 않습니다.

- `DART_API_KEY`: Open DART 인증키
- `SEC_USER_AGENT`: 서비스명과 실제 연락 이메일
- `REMOTE_SNAPSHOT_URL`: GitHub Actions가 커밋한 공개 snapshot raw 주소(선택)
- `ENABLE_SCHEDULER`: 로컬 서버 자동 갱신 여부
- `SCHEDULE_HOUR_KST`: 로컬 자동 갱신 시각, GitHub 완료 뒤인 21시 권장
- `SYNC_TOKEN`: 보호된 `POST /api/sync`를 사용할 때만 설정

## 구현 명세와 공식 문서

- [전체시장 구현 프롬프트 v2](./docs/FULL_MARKET_PROMPT.md)
- [기존 제품·점수 마스터 프롬프트](./docs/MASTER_PROMPT.md)
- [Open DART 공시검색](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)
- [Open DART 기업개황](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002)
- [Open DART 다중회사 주요계정](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019017)
- [Open DART 다중회사 재무지표](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2022002)
- [SEC EDGAR API와 야간 bulk 파일](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [GitHub Actions 예약 실행](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## 면책

이 서비스는 공개 공시자료를 정해진 규칙으로 분석한 정보·교육용 연구 도구입니다.
매수·매도·보유 권유나 미래 수익 보장이 아니며, 공시에는 지연·오류·사후 정정이 있을
수 있습니다. 투자 결정 전 반드시 원문 공시를 확인하세요.
