# Longview AWS 자동투자 인프라

이 디렉터리는 컴퓨터가 꺼져 있어도 데이터 수집과 자동투자 검증이 이어지도록
하는 AWS 기반 실행 환경입니다. 서울 리전(`ap-northeast-2`)을 기준으로
설계했습니다.

가장 중요한 초기 상태는 다음과 같습니다.

- 모든 Scheduler가 `DISABLED`입니다.
- 실행 모드는 `dry-run`입니다.
- SSM의 영구 긴급정지 스위치는 `true`입니다.
- KIS 및 공공데이터 Secret은 만들어지지만 값은 비어 있습니다.
- 따라서 템플릿을 배포하는 것만으로는 실제 주문이 나가지 않습니다.

비기술 운영자를 포함한 실제 최초 배포와 전환은
[AWS 자동투자 최초 배포·전환 runbook](../../docs/AWS_AUTOTRADE_RUNBOOK.md)의
순서와 확인란을 따릅니다. 최초 CloudFormation 스택 이름은 정확히
`longview-autotrade`이며 GitHub 배포에는 보호 environment
`aws-production`이 필요합니다. GitHub `live-autotrade.yml`은 영구 폐기된
안내용 stub으로, 더 이상 주문 실행 경로가 아닙니다.

## 구조

```text
EventBridge Scheduler (Asia/Seoul, retry 0, 짧은 event age)
  ├─ 거래/정산/감사 → Step Functions Standard → ECS Fargate .sync (30분)
  └─ 데이터 갱신   → 별도 Step Functions Standard → ECS Fargate .sync (2시간)

Fargate
  ├─ DynamoDB: lease, fencing token, cycle/order idempotency, KIS token cache
  ├─ S3: 검증된 immutable revision + latest manifest
  ├─ Secrets Manager: KIS JSON / DART·data.go.kr JSON
  ├─ SSM: 영구 kill switch
  ├─ KIS/OpenDART/data.go.kr: 공인 IPv4로 직접 TLS 연결
  └─ CloudWatch Logs/Metrics

S3 latest/ + revisions/ → CloudFront OAC(read-only) → 웹사이트와 투자기가 같은 revision 사용
실패 → SNS 알림, Scheduler 전달 실패 → SQS DLQ + CloudWatch 알람
GitHub main → OIDC 단기 자격증명 → ECR push + 이 스택만 갱신
```

NAT Gateway와 고정 IP는 만들지 않습니다. Fargate 작업은 실행 중에만 공인
IPv4를 받고, 보안 그룹은 TCP 443과 KIS의 TCP 9443 아웃바운드만 허용합니다.
KIS가 개인 Open API에 고정 IP를 새로 요구하는 경우에만 별도 설계를 검토해야
합니다.

## 컨테이너 계약

동일 이미지가 아래 네 명령을 지원해야 합니다.

```text
node scripts/aws-task.mjs sync
node scripts/aws-task.mjs auto
node scripts/aws-task.mjs reconcile
node scripts/aws-task.mjs audit
```

인프라는 비밀값 자체가 아니라 ARN과 리소스 이름만 환경 변수로 전달합니다.

| 환경 변수 | 의미 |
|---|---|
| `AUTOTRADE_STATE_TABLE` | DynamoDB 상태·락·멱등성 테이블 |
| `AUTOTRADE_SNAPSHOT_BUCKET` | private S3 버킷 |
| `AUTOTRADE_KIS_SECRET_ARN` | KIS JSON Secret ARN |
| `AUTOTRADE_DATA_SECRET_ARN` | DART/data.go.kr JSON Secret ARN |
| `AUTOTRADE_KILL_SWITCH_PARAMETER` | SSM kill switch 이름 |
| `AUTOTRADE_EXECUTION_MODE` | `dry-run` 또는 `live` |
| `AUTOTRADE_LIVE_ENABLED` | live 모드에서만 `true` |
| `AUTOTRADE_TASK_SOURCE` | 실행 출처(`eventbridge-scheduler` 또는 승인된 수동 실행) |
| `AUTOTRADE_EXECUTION_ID` | Step Functions 실행 ARN 등 실행별 고유 ID |
| `AUTOTRADE_SCHEDULED_AT` | Scheduler가 의도한 UTC 시각 |
| `AUTOTRADE_SCHEDULE_ARN` | 호출한 스케줄 ARN |
| `AUTOTRADE_SCHEDULE_SLOT` | auto/reconcile/audit 실행 슬롯 |
| `AUTOTRADE_FINAL_RECONCILE` | final 스케줄에서만 `true` |
| `AUTOTRADE_FINAL_RECONCILE_SLOT` | 최종 슬롯 이름 `reconcile-final` |
| `AUTOTRADE_METRIC_NAMESPACE` | `Longview/Autotrade` |
| `AUTOTRADE_STACK_NAME` | 알람 metric dimension 값 |
| `AUTOTRADE_AWS_TRADE_LEASE_MS` | 거래 lease(기본 45분) |
| `AUTOTRADE_AWS_SYNC_LEASE_MS` | 데이터 sync lease(AWS 설정 135분) |
| `AUTOTRADE_AWS_LEASE_HEARTBEAT_MS` | 공통 lease heartbeat(기본 2분) |
| `AUTOTRADE_TASK_DEADLINE_MS` | 상태 머신 timeout 직전 안전 종료 deadline |

예약 지연 한도는 운영자가 느슨하게 바꿀 수 없는 런타임 안전 상수입니다.
거래·정산·감사는 10분, 데이터 sync는 30분을 넘긴 Scheduler 이벤트를
거부합니다.

SSM 제어 파라미터는 문자열 boolean이 아니라 다음 JSON 계약을 사용합니다.
`schemaVersion`, `killSwitch`, `liveEnabled`는 필수이고 `reason`, `updatedAt`은
선택입니다.

```json
{
  "schemaVersion": 1,
  "killSwitch": true,
  "liveEnabled": false,
  "reason": "bootstrap-safe",
  "updatedAt": "2026-07-24T00:00:00.000Z"
}
```

live 신규 주문은 `liveEnabled=true`이고 `killSwitch=false`일 때만 허용됩니다.
초기값은 안전하게 신규 주문을 차단합니다.

작업 자체의 자동 재시도는 없습니다. 외부 주문 API의 응답이 불명확한 경우
재전송하지 않고, 먼저 주문 intent를 DynamoDB에 기록한 뒤 KIS 주문내역을
조회해 해소해야 하기 때문입니다. Scheduler도 전달 재시도 횟수가 0입니다.
대신 auto/reconcile/audit의 각 예약 호출은 안정된 cycle key를 사용하며,
DynamoDB 조건부 쓰기가 중복 호출이나 수동 재실행의 중복 주문을 막습니다.

거래와 데이터 sync는 서로 다른 ECS task role과 task definition을 사용합니다.
거래 task는 KIS Secret과 snapshot 읽기만 가능하고, sync task는 시장데이터
Secret 및 snapshot 쓰기만 가능합니다. 따라서 sync 버그가 KIS 주문권한을
얻거나 거래 task가 공개 점수 revision을 바꿀 수 없습니다. 두 상태 머신은
컨테이너 종료 후 `ExitCode == 0`을 명시적으로 검사합니다.

## 공개 snapshot 계약

S3 전체는 private이고 CloudFront는 `latest/`와 `revisions/`만 읽을 수 있습니다.
`sync`는 다음 순서를 지켜야 합니다.

1. 로컬 임시 경로에서 수집·점수·선정목록을 모두 완성합니다.
2. 데이터 완전성, 가격 날짜, 기업 수, JSON schema를 검증합니다.
3. 불변 경로에 먼저 업로드합니다.
   - `revisions/<revision>/companies.json`
   - `revisions/<revision>/trading-selection-<selection-sha256>.json`
4. 각 업로드의 SHA-256과 byte 수를 확인합니다.
5. 마지막 한 번의 `PutObject`로 `latest/manifest.json`을 교체합니다.
6. `SnapshotPublishSuccess{StackName=<stack>}=1` metric을 기록합니다.

선정 목록 경로에는 내용 해시를 포함합니다. 같은 원본 revision으로 sync가
재시도되더라도 생성시각 등 선정 파일 내용이 달라질 수 있는데, 이 경우에도
기존 불변 객체와 충돌하거나 직전 정상 manifest를 손상시키지 않습니다.

`latest/manifest.json`의 최소 형태는 다음과 같습니다.

```json
{
  "schemaVersion": 1,
  "revision": "0123456789abcdef0123",
  "sourceUpdatedAt": "2026-07-24T12:35:00.000Z",
  "selectionGeneratedAt": "2026-07-24T12:36:00.000Z",
  "publishedAt": "2026-07-24T12:37:00.000Z",
  "artifacts": {
    "companies": {
      "key": "revisions/0123456789abcdef0123/companies.json",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "bytes": 33427408,
      "contentType": "application/json"
    },
    "selection": {
      "key": "revisions/0123456789abcdef0123/trading-selection-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 12104,
      "contentType": "application/json"
    }
  }
}
```

거래기와 웹사이트는 모두 `latest/manifest.json`을 먼저 읽고, 명시된 불변 객체 및
checksum을 사용해야 합니다. 실패한 sync는 manifest를 바꾸지 않으므로 직전
검증 revision이 계속 제공됩니다. `latest/manifest.json`은 짧은 cache-control을,
revision 객체는 `immutable` cache-control을 사용해야 합니다.

Fargate 로컬 디스크는 실행이 끝나면 사라집니다. DART 전체시장을 매 실행마다
처음부터 다시 요청하면 일일 호출한도에 걸릴 수 있으므로 수집 checkpoint를
`private/sync-checkpoints/dart/`에 내려받고 다시 저장해야 합니다. 이 prefix는
sync task role만 읽고 쓸 수 있고 CloudFront에는 공개되지 않습니다.

## DynamoDB 안전 계약

하나의 on-demand 테이블에 문자열 파티션 키 `pk`만 사용합니다. 레코드 종류와
고유 식별자는 `pk` 값에 함께 인코딩하며, 구현은 최소한 다음을 조건부 쓰기로
보장해야 합니다.

- 30~45분 lease, 2~5분 heartbeat, owner와 fencing token 검증
- `tradeDate + revision` 단위 cycle 멱등성
- `cycle + symbol + side + target` 단위 주문 intent
- 외부 주문 POST 전에 intent 저장
- 응답 불명확 시 `unknown`으로 동결하고 KIS 주문내역으로만 해소
- 토큰 만료시각과 분산 refresh lock
- 감사 작업이 당일 성공 또는 명시적 safe-skip 기록을 확인

TTL 속성은 epoch seconds인 `ttl`입니다. 주문 감사자료에는 장기 TTL을
쓰거나 TTL을 생략해야 합니다. 테이블은 on-demand, 암호화, PITR 활성 상태이며
스택 삭제 시에도 보존됩니다.

## Scheduler 시각

모든 표현식은 `Asia/Seoul` 시간대입니다.

| 스케줄 | 시각 | 기본 상태 |
|---|---|---|
| 일일 auto 판단 | 평일 09:10부터 14:40까지 30분 간격(첫 성공 뒤 멱등 skip) | 비활성 |
| 미체결 close 정산 | 평일 15:13 | 비활성 |
| 장후 첫 검증 | 평일 15:45 | 비활성 |
| 장후 최종 검증 | 평일 15:55 (`final=true`) | 비활성 |
| 장후 최종 검증 독립 재시도 | 평일 16:05 (`final=true`) | 비활성 |
| 일일 성공 여부 감사 | 평일 16:30, 16:40 | 비활성 |
| 데이터 갱신 | 매일 19:35, 22:35 (같은 KST 날짜의 멱등 후속 시도) | 비활성 |

auto는 주문 허용창 밖이면 안전하게 skip해야 합니다. 한국 휴장일은
KIS 휴장일 API/거래일 검사로 skip해야 하며, 단순 월~금만으로 주문 가능일을
판단하면 안 됩니다. 15:13 실행은 미체결 취소, 15:45와 15:55 실행은
`not_found`를 서로 다른 두 번의 장후 조회로 확정하는 데 사용하며 모두 같은
멱등 reconcile 명령입니다. 마지막 실행만 `reconcile-final`과 `final=true`를
받습니다. 16:05 실행은 같은 `reconcile-final` 슬롯으로 시작 지연이나 lease
경합 뒤의 최종 검증을 독립 재시도합니다. 16:30과 16:40 audit가 최종 상태를
중복 확인합니다.

## 최초 배포 고정 계약

ECR, GitHub OIDC provider와 GitHub role을 이 스택 자체가 만들기 때문에
**최초 한 번은 GitHub workflow로 이 스택을 만들 수 없습니다.** AWS
CloudFormation 콘솔에서 `template.yaml`을 올리고 다음 계약을 지킵니다.

- 스택 이름: 정확히 `longview-autotrade`
- 리전: 서울(`ap-northeast-2`)
- 초기값: `ExecutionMode=dry-run`, 두 schedule `false`, 영구 kill switch
  `true`
- GitHub protected environment: 정확히 `aws-production`
- repository variables:
  - `AWS_STACK_NAME=longview-autotrade`
  - `AWS_DEPLOY_ROLE_ARN` ← `GitHubDeployRoleArn`
  - `AWS_CLOUDFORMATION_ROLE_ARN` ← `CloudFormationExecutionRoleArn`
  - `AWS_BOOTSTRAP_ROLE_ARN` ← `GitHubBootstrapRoleArn`

GitHub OIDC provider가 계정에 이미 있으면
`CreateGitHubOidcProvider=false`와 기존 provider ARN을 사용합니다. Outputs를
등록한 뒤 `aws-deploy.yml`이 실제 commit 이미지를 push하는 2단계
부트스트랩입니다.

최초 이후 IAM role·policy·OIDC 리소스 자체를 바꾸는 업데이트는 제한된 GitHub
CloudFormation role로 수행되지 않을 수 있습니다. 이 경우 역할 권한을 즉석에서
넓히지 말고 관리자가 변경 내용을 검토한 뒤 콘솔에서 정확한
`longview-autotrade` 스택을 수동 업데이트하고 IAM capability를 승인합니다.
일반 이미지 배포에는 계속 제한된 GitHub 역할을 사용합니다.

## Secret 입력

기존 GitHub Actions 암호화 Secret을 다시 화면에 꺼내지 않고 옮기려면
`aws-bootstrap.yml`을 수동 실행해 `operation=seed-secrets`,
`confirmation=SEED_AWS_SECRETS`를 사용합니다. 제한된 OIDC 역할은 이 스택의
두 Secret에 새 버전을 쓰는 권한만 가지며 공개 결과에는 Secret 개수만
나옵니다. Actions Secret을 사용하지 않는 경우에는 Secrets Manager 콘솔에서
CloudFormation Output이 가리키는 빈 Secret에 새 버전을 직접 저장할 수
있습니다. 실제 값은 채팅, 일반 workflow 입력, CloudFormation 파라미터,
저장소 또는 GitHub 로그에 넣지 않습니다.

KIS Secret JSON 키:

```json
{
  "KIS_APP_KEY": "실제값",
  "KIS_APP_SECRET": "실제값",
  "KIS_ACCOUNT_NUMBER": "계좌 앞 8자리",
  "KIS_ACCOUNT_PRODUCT_CODE": "01",
  "KIS_HTS_ID": "실제값"
}
```

시장 데이터 Secret JSON 키:

```json
{
  "DART_API_KEY": "실제값",
  "DATA_GO_KR_API_KEY": "실제값"
}
```

Secret을 task definition의 `Secrets`에 직접 주입하지 않은 이유는 전체
컨테이너 환경과 ECS 메타데이터에 오래 남기지 않기 위해서입니다. 런타임이
AWS SDK로 읽고, 로그 redaction 목록에 즉시 등록한 뒤 사용해야 합니다.

## GitHub OIDC 배포

저장소에 protected environment `aws-production`을 만들고 위의 repository
variable 네 개를 등록합니다. `aws-deploy.yml`과 `aws-bootstrap.yml`은 이
environment를 선언하고 자체 preflight에서 `main` 브랜치를 강제합니다. IAM
OIDC trust는 이 저장소의 `aws-production` environment subject만 허용하므로,
environment에도 main 배포 제한과 가능하면 승인자를 설정합니다. 장기 AWS
access key는 GitHub Secrets에 만들지 않습니다.

ECR tag는 commit SHA이며 immutable입니다. 같은 commit 재실행 시 workflow는
기존 이미지를 재사용합니다. 인프라 배포는 schedule을 임의로 활성화하지
않고 기존 CloudFormation 파라미터를 보존합니다. 템플릿은 CloudFormation의
직접 API body 한도보다 크므로 workflow가 private S3의
`deployment/cloudformation/` prefix에 먼저 올립니다. 이 prefix는
CloudFront에 공개되지 않습니다.

## 검증 후 live 전환 순서

세부 확인란은 [운영 runbook](../../docs/AWS_AUTOTRADE_RUNBOOK.md)을 따르며,
아래 순서를 바꾸지 않습니다.

1. AWS 계정, MFA, 결제 연락처와 Budget을 준비합니다.
2. schedule off, dry-run, kill switch true인 안전 기본 스택을 콘솔에서
   `longview-autotrade`라는 정확한 이름으로 만듭니다.
3. GitHub `aws-production` environment와 repository variable 네 개를
   설정합니다.
4. `aws-deploy.yml`로 검증된 commit 이미지를 배포합니다.
5. 비밀값은 AWS Secrets Manager에만 seed합니다.
6. 거래 schedule을 끈 채 AWS data sync, 불변 revision, checksum과 CloudFront
   manifest를 검증합니다.
7. legacy GitHub live 실행기를 중지하고 drain한 뒤, KIS 실잔고를 대조하고
   state를 DynamoDB로 한 번 이전합니다.
8. AWS 거래를 dry-run으로 3~5영업일 관찰합니다.
9. legacy `daily-sync.yml`을 GitHub UI에서 disable하고 웹사이트를 CloudFront
   `LatestManifestUrl`로 전환합니다.
10. 모든 게이트가 통과한 뒤에만 live acknowledgement와 SSM
    `killSwitch=false`, `liveEnabled=true`를 명시적으로 적용합니다.

수동 State Machine 입력 예:

```json
{
  "command": "audit",
  "source": "manual",
  "triggerId": "manual-audit-001",
  "scheduledAt": "2026-07-24T07:30:00Z",
  "scheduleArn": "manual",
  "reconcileSlot": "audit",
  "finalReconcile": "false"
}
```

수동 data sync는 `DataSyncStateMachineArn`에 다음 입력을 사용합니다.

```json
{
  "command": "sync",
  "source": "manual",
  "triggerId": "manual-sync-001",
  "scheduledAt": "2026-07-24T10:35:00Z",
  "scheduleArn": "manual",
  "reconcileSlot": "sync",
  "finalReconcile": "false"
}
```

CloudFormation 업데이트 중 SSM 리소스 속성이 바뀌면 안전을 위해 kill switch가
다시 `true`가 될 수 있습니다. 매 배포 후 live 상태 점검에서 반드시 확인해야
합니다.

## 비용과 보존

월 비용을 고정 금액으로 단정하지 않습니다. 실제 비용은 Fargate 실행시간,
공인 IPv4 사용시간, CloudFront 요청·전송량, 로그와 저장량에 따라 달라집니다.
배포 전 [AWS Pricing Calculator](https://calculator.aws/)와
[Fargate](https://aws.amazon.com/fargate/pricing/),
[VPC](https://aws.amazon.com/vpc/pricing/),
[CloudFront](https://aws.amazon.com/cloudfront/pricing/),
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)의 공식 요금표로
예상량을 계산하고, 배포 후
[Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/)와
[AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html)로
실측 비용과 경보를 관리합니다. 이전 S3 object version은 90일 뒤, private
배포 템플릿은 30일 뒤 정리됩니다. 검증 revision 자체는 재현 가능성을 위해
자동 삭제하지 않으므로 장기 운영 시 보존기간을 사용자가 정해야 합니다.

S3 snapshot, DynamoDB table, ECR repository, Secrets, SSM kill switch,
CloudFormation execution role, GitHub OIDC provider는 실수로 스택을 지워도
데이터/접근 복구가 가능하도록 `Retain`됩니다. 완전 삭제 시에는 정확한 대상과
백업을 확인한 후 각각 수동 삭제해야 하며, ECR/S3가 남아 있으면 소액 비용이
계속 발생할 수 있습니다.
