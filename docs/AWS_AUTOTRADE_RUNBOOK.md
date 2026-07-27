# AWS 자동투자 최초 배포·전환 runbook

이 문서는 AWS나 GitHub에 익숙하지 않은 운영자가 Longview 자동투자를 안전하게
옮길 때 사용하는 체크리스트입니다. 상세 설계는
[AWS 인프라 설명](../infra/aws/README.md)을 함께 봅니다.

가장 중요한 원칙은 **데이터 갱신과 주문 실행을 한 번에 전환하지 않는 것**입니다.
각 단계의 확인란이 모두 충족된 뒤에만 다음 단계로 넘어갑니다.

## 고정 이름과 역할

아래 이름은 임의로 바꾸지 않습니다.

| 항목 | 정확한 값 |
|---|---|
| AWS 리전 | `ap-northeast-2` (서울) |
| CloudFormation 스택 이름 | `longview-autotrade` |
| GitHub 보호 environment | `aws-production` |
| repository variable | `AWS_STACK_NAME=longview-autotrade` |
| repository variable | `AWS_DEPLOY_ROLE_ARN=<GitHubDeployRoleArn Output>` |
| repository variable | `AWS_CLOUDFORMATION_ROLE_ARN=<CloudFormationExecutionRoleArn Output>` |
| repository variable | `AWS_BOOTSTRAP_ROLE_ARN=<GitHubBootstrapRoleArn Output>` |

세 ARN은 비밀키가 아니라 CloudFormation Output의 리소스 식별자입니다. 그래도
다른 값과 혼동하지 말고 해당 Output을 그대로 복사합니다.

GitHub workflow의 역할은 다음처럼 구분됩니다.

- `aws-deploy.yml`: 검증된 commit 이미지를 ECR에 올리고 정확히
  `longview-autotrade` 스택만 갱신합니다.
- `aws-bootstrap.yml`: 제한된 역할로 상태를 점검·이전합니다.
- `live-autotrade.yml`: **영구 폐기된 안내용 stub**입니다. 실행해도 주문하지
  않으며 AWS 운영을 대신하지 않습니다.
- `daily-sync.yml`: AWS 데이터 전환이 끝날 때까지만 남겨 두는 legacy
  데이터 갱신 workflow입니다.

App Key, App Secret, 계좌번호, 공공데이터 인증키, 암호화 키 같은 비밀값은
문서, Git commit, GitHub **variable**, workflow 입력란, 채팅, 화면 캡처 또는
로그에 입력하지 않습니다. 이미 등록된 값은 GitHub의 암호화된 Actions
**Secret**에서만 읽어 AWS Secrets Manager로 전송하며, 실제 값을 이
runbook에도 기록하지 않습니다.

## 1. AWS 계정 보호와 비용 경보

- [ ] 루트 사용자와 운영 IAM 사용자에 MFA를 설정했습니다.
- [ ] 결제 연락처와 보안 연락처를 확인했습니다.
- [ ] 월 비용 Budget과 이메일 알림을 만들었습니다.
- [ ] Cost Explorer에서 서비스별 비용을 볼 수 있게 했습니다.
- [ ] 작업 리전이 서울(`ap-northeast-2`)인지 확인했습니다.

비용은 실행 횟수, Fargate 실행시간, 공인 IPv4 사용시간, 로그량, 저장량과
CloudFront 요청·전송량에 따라 달라집니다. 배포 전에
[AWS Pricing Calculator](https://calculator.aws/),
[AWS Fargate 요금](https://aws.amazon.com/fargate/pricing/),
[Amazon VPC 요금](https://aws.amazon.com/vpc/pricing/),
[CloudFront 요금](https://aws.amazon.com/cloudfront/pricing/),
[CloudWatch 요금](https://aws.amazon.com/cloudwatch/pricing/)에서 현재 리전과
예상 사용량으로 계산합니다. 운영 중에는
[Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/)로
실제 비용을 확인하고 [AWS Budget 생성 안내](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html)에
따라 경보 금액을 조정합니다. 문서에 고정 월 금액을 적어 예산으로 대신하지
않습니다.

## 2. 안전 기본 스택을 콘솔에서 최초 생성

최초 스택은 ECR과 GitHub OIDC 역할 자체를 만들므로 GitHub workflow로 만들 수
없습니다. AWS CloudFormation 콘솔에서 `infra/aws/template.yaml`을 업로드합니다.

- [ ] **스택 이름을 정확히 `longview-autotrade`로 입력했습니다.**
- [ ] `ExecutionMode=dry-run`을 유지했습니다.
- [ ] `EnableTradingSchedule=false`를 유지했습니다.
- [ ] `EnableDataSyncSchedule=false`를 유지했습니다.
- [ ] `LiveTradingAcknowledgement`를 비워 두었습니다.
- [ ] `GitHubDeployEnvironment=aws-production`을 유지했습니다.
- [ ] `GitHubRepository`가 실제 `owner/repository`와 일치합니다.
- [ ] IAM 리소스 생성 승인을 확인하고 스택 생성 완료를 기다렸습니다.
- [ ] Output `SafetyStatus`와 SSM 제어값에서 schedule off, dry-run,
  `killSwitch=true`, `liveEnabled=false`를 확인했습니다.

AWS 계정에 GitHub OIDC provider가 이미 있으면 중복 생성하지 않습니다.
`CreateGitHubOidcProvider=false`와 기존 provider ARN을 사용합니다.

최초 배포 뒤 IAM 역할·정책 또는 OIDC처럼 IAM 리소스 자체를 변경하는 템플릿
업데이트는 제한된 GitHub CloudFormation 역할로 수행되지 않을 수 있습니다.
그 경우 실패한 배포를 반복하거나 역할 권한을 임의로 넓히지 말고, 변경 내용을
검토한 관리자가 CloudFormation 콘솔에서 `longview-autotrade` 스택을 수동
업데이트하고 IAM capability를 명시적으로 승인합니다. 일반 컨테이너 이미지
배포는 계속 제한된 GitHub 역할을 사용합니다.

## 3. GitHub 보호 environment와 변수 설정

저장소 **Settings → Environments**에서 `aws-production`을 정확히 만들고, 가능한
경우 required reviewer와 main 브랜치 배포 제한을 설정합니다. 두 AWS workflow는
이 environment를 사용해야만 OIDC 역할을 맡을 수 있습니다.

저장소 **Settings → Secrets and variables → Actions → Variables**에 아래 네 값을
등록합니다.

```text
AWS_STACK_NAME=longview-autotrade
AWS_DEPLOY_ROLE_ARN=<GitHubDeployRoleArn Output>
AWS_CLOUDFORMATION_ROLE_ARN=<CloudFormationExecutionRoleArn Output>
AWS_BOOTSTRAP_ROLE_ARN=<GitHubBootstrapRoleArn Output>
```

- [ ] environment 이름이 `aws-production`입니다.
- [ ] `AWS_STACK_NAME`이 정확히 `longview-autotrade`입니다.
- [ ] 세 role ARN이 각 CloudFormation Output과 일치합니다.
- [ ] 장기 AWS access key를 GitHub Secret에 만들지 않았습니다.
- [ ] 어떤 비밀값도 repository variable에 넣지 않았습니다.
- [ ] `AUTOTRADE_LIVE_ENABLED=false` repository variable을 확인했습니다.

## 4. 검증된 컨테이너 이미지 배포

GitHub **Actions → Deploy Longview AWS runtime → Run workflow**를 main에서
실행합니다. 이 workflow는 검사에 통과한 commit SHA 이미지를 ECR에 올리고
안전 파라미터를 바꾸지 않은 채 스택을 갱신합니다.

- [ ] workflow가 `aws-production` 승인 절차를 거쳤습니다.
- [ ] 코드 검사가 성공했습니다.
- [ ] ECR 이미지 태그가 실행한 commit SHA와 같습니다.
- [ ] CloudFormation 업데이트가 완료되었습니다.
- [ ] 배포 후에도 schedule off, dry-run, kill switch true입니다.

## 5. AWS Secrets Manager에 비밀값 입력

이미지 배포가 끝난 뒤 GitHub의 암호화된 Actions Secret에 이미 등록된 다음
이름을 확인합니다. 실제 값은 열거나 다시 복사하지 않습니다.

```text
KIS_APP_KEY
KIS_APP_SECRET
KIS_ACCOUNT_NUMBER
KIS_ACCOUNT_PRODUCT_CODE
KIS_HTS_ID
DART_API_KEY
DATA_GO_KR_API_KEY
AUTOTRADE_STATE_KEY
```

GitHub **Actions → Bootstrap Longview AWS data → Run workflow**에서
`operation=seed-secrets`, `confirmation=SEED_AWS_SECRETS`를 선택합니다.
제한된 OIDC 역할과 일회성 runner가 KIS/시장데이터 Secret 두 개에 새 버전을
저장하며, workflow는 실제 값을 출력하지 않습니다. 비밀값을 CloudFormation
파라미터나 일반 workflow 입력란에 붙여 넣지 않습니다.

해당 GitHub Secret이 없는 경우에만 CloudFormation Output `KisSecretArn`과
`MarketDataSecretArn`이 가리키는 Secret에 AWS Secrets Manager 콘솔로 직접
JSON을 저장합니다. `AUTOTRADE_STATE_KEY`는 7단계 이전이 끝날 때까지 GitHub
Actions Secret에 남아 있어야 합니다.

- [ ] KIS 자격정보는 KIS Secret에만 저장했습니다.
- [ ] DART/data.go.kr 자격정보는 market-data Secret에만 저장했습니다.
- [ ] 콘솔 화면, 브라우저 기록, 문서와 로그에 값을 남기지 않았습니다.
- [ ] task definition에는 비밀값이 아니라 Secret ARN만 전달됩니다.

## 6. AWS 데이터 sync와 CloudFront artifact 검증

거래 스케줄은 계속 끈 상태에서 `DataSyncStateMachineArn`을 수동 실행합니다.
성공한 sync만 S3의 불변 revision을 만든 뒤 마지막에
`latest/manifest.json`을 교체합니다.

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

- [ ] 수동 sync가 성공했고 CloudWatch/SNS/DLQ에 새 오류가 없습니다.
- [ ] `LatestManifestUrl`이 HTTPS로 열리고 manifest JSON을 반환합니다.
- [ ] manifest의 revision 객체가 존재하고 byte 수와 SHA-256 검증을 통과합니다.
- [ ] 웹사이트용 companies와 거래용 selection이 같은 revision을 가리킵니다.
- [ ] 같은 입력의 재실행이 중복 게시나 손상을 만들지 않았습니다.
- [ ] 필요하면 `EnableDataSyncSchedule=true`만 적용해 예약 sync도 검증했습니다.
- [ ] 최소 3회의 정상 sync와 실패 시 직전 manifest 보존을 확인했습니다.

이 단계에서는 legacy `daily-sync.yml`을 아직 끄지 않습니다. AWS 공개 artifact와
웹사이트 전환이 검증될 때까지 데이터 공급의 복구 경로로 남겨 둡니다.

## 7. legacy 실전 주문 중지·drain·상태 이전

AWS 거래 dry-run보다 먼저 과거 GitHub 주문 실행기를 완전히 멈춥니다.
현재 `live-autotrade.yml`은 retired stub이어야 하며 주문 코드나 schedule이 다시
추가되어 있으면 전환을 중단합니다.

- [ ] GitHub의 legacy live workflow schedule/실전 허용 변수를 비활성화했습니다.
- [ ] 실행 중인 legacy job이 없고 새 job이 시작되지 않음을 확인했습니다.
- [ ] KIS에서 미체결 주문을 확인하고 필요한 취소·대조를 끝냈습니다.
- [ ] `aws-bootstrap.yml`의 `inspect-state`로 원본과 AWS 대상 상태를
  읽기 전용 점검했습니다.
- [ ] KIS 실잔고와 legacy 원장을 읽기 전용으로 대조했습니다.
- [ ] 확인 문자열 `MIGRATE_GITHUB_STATE_TO_AWS`를 사용한 `migrate-state`가
  정확히 한 번 성공했습니다.
- [ ] DynamoDB의 이전 결과를 다시 읽어 현금·보유·주문 상태가 일치합니다.
- [ ] 이전 완료 후 더는 필요 없는 legacy KIS/시장데이터 GitHub Secret의
  삭제·회전 시점을 정했습니다.

빈 DynamoDB 상태로 live를 시작하거나, 두 주문 실행기를 동시에 켜지 않습니다.
`AWS_BOOTSTRAP_ROLE_ARN`은 이 제한된 상태 작업에만 사용합니다.

## 8. AWS 거래 dry-run을 3~5영업일 관찰

상태 이전이 검증된 뒤에만 `ExecutionMode=dry-run`, SSM `killSwitch=true`를
유지하면서 `EnableTradingSchedule=true`로 바꿉니다. 한국 공휴일은 영업일 관찰
일수에 포함하지 않습니다.

예약 시각은 모두 `Asia/Seoul`입니다.

| 역할 | 시각 |
|---|---|
| auto 판단 | 평일 09:10~14:40, 30분 간격 |
| 미체결 close 정산 | 평일 15:13 |
| 첫 장후 검증 | 평일 15:45 |
| 최종 검증 | 평일 15:55 |
| 최종 reconcile 독립 재시도 | 평일 **16:05** |
| 일일 감사 | 평일 16:30, 16:40 |
| 데이터 sync | 매일 19:35, 22:35 |

16:05 스케줄은 15:55 실행의 시작 지연이나 lease 경합을 보완하는 별도 호출이며
`reconcileSlot=reconcile-final`, `finalReconcile=true`를 사용합니다.

수동 전체 감사가 필요할 때 `StateMachineArn`에 다음 payload를 사용합니다.
`source`, `scheduleArn`, `reconcileSlot`, `finalReconcile`을 생략하거나 다른 값으로
바꾸지 않습니다.

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

- [ ] 서로 다른 3~5영업일에 auto·reconcile·audit 결과를 확인했습니다.
- [ ] 실제 주문은 한 건도 전송되지 않았습니다.
- [ ] 중복 trigger, partial fill, API timeout, stale snapshot과 lease 경합을
  시험했습니다.
- [ ] `unknown` 주문 동결, DLQ, 알림과 재대조가 예상대로 동작했습니다.
- [ ] 15:55와 16:05 final reconcile 결과를 모두 확인했습니다.

## 9. legacy 데이터 sync 중지와 웹사이트 manifest 전환

AWS 데이터 sync와 거래 dry-run이 모두 합격한 뒤에만 GitHub
**Actions → Daily Korean market sync → Disable workflow**로 legacy
`daily-sync.yml`을 중지합니다. 코드를 삭제하는 것만으로 중지를 대신하지 않습니다.

웹 서버의 런타임 설정에 CloudFormation Output `LatestManifestUrl`을 사용합니다.
값은 공개 CloudFront HTTPS 주소이며 비밀이 아닙니다.

```dotenv
REMOTE_ARTIFACT_MANIFEST_URL=https://<cloudfront-domain>/latest/manifest.json
REMOTE_SNAPSHOT_TOKEN=
```

- [ ] legacy daily-sync workflow가 disabled이고 예약 실행이 더 생기지 않습니다.
- [ ] 기존 GitHub raw용 `REMOTE_SNAPSHOT_TOKEN`을 비우거나 삭제했습니다.
- [ ] 웹 서버를 재시작한 뒤 CloudFront manifest를 읽습니다.
- [ ] 웹사이트와 AWS 거래기가 동일 revision과 selection checksum을 표시합니다.
- [ ] AWS sync 실패 시 직전 정상 revision을 계속 제공합니다.

## 10. 명시적인 live 잠금 해제

아래 조건을 하나라도 만족하지 못하면 live로 바꾸지 않습니다.

- [ ] 앞 단계의 모든 확인란과 3~5영업일 dry-run이 통과했습니다.
- [ ] legacy live와 legacy daily-sync가 모두 중지됐습니다.
- [ ] AWS state, KIS 실잔고와 미체결 주문이 일치합니다.
- [ ] 알림 수신자와 즉시 중지 담당자가 정해져 있습니다.
- [ ] 전용계좌·자본상한·종목/회전율 한도를 다시 확인했습니다.

그 다음 CloudFormation 콘솔의 정확한 `longview-autotrade` 스택에서
`ExecutionMode=live`, `EnableTradingSchedule=true`,
`EnableDataSyncSchedule=true`, 그리고 요구되는 정확한 live acknowledgement를
명시적으로 적용합니다. 배포 성공과 task definition을 확인한 뒤, 마지막
독립 단계로 SSM 제어 JSON을 `killSwitch=false`, `liveEnabled=true`로
변경합니다. 이 두 값이 모두 맞아야 신규 주문이 허용됩니다.

비상 중지는 반대 순서가 아니라 **SSM `killSwitch=true`를 가장 먼저** 적용합니다.
그 다음 거래 스케줄을 끄고, 진행 중 task와 KIS 미체결 주문을 확인하며, 원인을
조사하기 전에는 live 잠금을 다시 풀지 않습니다.

CloudFormation 업데이트 후에는 SSM 리소스 변경으로 kill switch가 다시 true가
될 수 있으므로, 모든 배포 뒤 현재 제어 JSON과 실제 주문 차단 상태를 확인합니다.
