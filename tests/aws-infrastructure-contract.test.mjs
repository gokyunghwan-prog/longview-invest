import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { awsResourceSettings } from "../autotrade/aws/runner.mjs";

const [
  template,
  deployWorkflow,
  bootstrapWorkflow,
  validateWorkflow,
  dockerfile,
  dockerignore,
  artifacts,
  runner,
  legacyWorkflow
] =
  await Promise.all([
    readFile("infra/aws/template.yaml", "utf8"),
    readFile(".github/workflows/aws-deploy.yml", "utf8"),
    readFile(".github/workflows/aws-bootstrap.yml", "utf8"),
    readFile(".github/workflows/aws-validate.yml", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile(".dockerignore", "utf8"),
    readFile("lib/aws-artifacts.mjs", "utf8"),
    readFile("autotrade/aws/runner.mjs", "utf8"),
    readFile(".github/workflows/live-autotrade.yml", "utf8")
  ]);

test("AWS stack은 dry-run·스케줄 off·JSON kill switch로 생성된다", () => {
  assert.match(template, /ExecutionMode:[\s\S]*?Default: dry-run/);
  assert.match(template, /EnableTradingSchedule:[\s\S]*?Default: "false"/);
  assert.match(template, /EnableDataSyncSchedule:[\s\S]*?Default: "false"/);
  assert.match(
    template,
    /\{"schemaVersion":1,"killSwitch":true,"liveEnabled":false,"reason":"bootstrap-safe"\}/
  );
  assert.match(
    template,
    /LiveModeRequiresExplicitAcknowledgement:[\s\S]*?I_ACKNOWLEDGE_LIVE_TRADING/
  );
});

test("DynamoDB key·TTL과 앱의 checkpoint prefix가 IAM 계약과 일치한다", () => {
  const table = template.slice(
    template.indexOf("  AutotradeStateTable:"),
    template.indexOf("  KisCredentialsSecret:")
  );
  assert.equal((table.match(/AttributeName: pk/g) || []).length, 2);
  assert.doesNotMatch(table, /AttributeName: sk/);
  assert.match(table, /AttributeName: ttl[\s\S]*?Enabled: true/);
  assert.match(template, /private\/sync-checkpoints\/\*/);
  assert.match(artifacts, /private\/sync-checkpoints\/dart\//);
});

test("ECS task role은 명령별 실제 AWS API와 checkpoint prefix로 제한된다", () => {
  const tradingRole = template.slice(
    template.indexOf("  TradingTaskRole:"),
    template.indexOf("  DataSyncTaskRole:")
  );
  const syncRole = template.slice(
    template.indexOf("  DataSyncTaskRole:"),
    template.indexOf("  TradingTaskDefinition:")
  );
  for (const forbidden of [
    "dynamodb:Scan",
    "dynamodb:BatchWriteItem",
    "s3:ListBucketVersions",
    "secretsmanager:DescribeSecret",
    "cloudwatch:PutMetricData",
    "sns:Publish"
  ]) {
    assert.doesNotMatch(tradingRole, new RegExp(forbidden));
    assert.doesNotMatch(syncRole, new RegExp(forbidden));
  }
  assert.doesNotMatch(tradingRole, /s3:ListBucket/);
  assert.match(syncRole, /s3:ListBucket[\s\S]*?private\/sync-checkpoints\/dart\/\*/);
  assert.match(syncRole, /s3:ListBucket[\s\S]*?latest\/manifest\.json/);
  assert.doesNotMatch(syncRole, /dynamodb:PutItem/);
});

test("Step Functions가 Scheduler 신원·시각·slot을 정확한 runtime env로 전달한다", () => {
  for (const name of [
    "AUTOTRADE_TASK_SOURCE",
    "AUTOTRADE_EXECUTION_ID",
    "AUTOTRADE_SCHEDULED_AT",
    "AUTOTRADE_SCHEDULE_SLOT",
    "AUTOTRADE_FINAL_RECONCILE"
  ]) {
    assert.match(template, new RegExp(`\"Name\": \"${name}\"`));
  }
  assert.doesNotMatch(template, /AUTOTRADE_TRIGGER_ID/);
  assert.doesNotMatch(template, /AUTOTRADE_RECONCILE_SLOT/);
  assert.match(runner, /invocation\.finalReconcile/);
  assert.doesNotMatch(runner, /AUTOTRADE_RECONCILE_FINAL/);
  assert.equal(
    (template.match(/"source": "eventbridge-scheduler"/g) || []).length,
    7
  );
  assert.match(template, /Name: AUTOTRADE_EXPECTED_SCHEDULE_GROUP/);
  assert.match(template, /Name: AUTOTRADE_EXPECTED_SCHEDULE_NAME_PREFIX/);
  assert.match(template, /Name: !Sub \$\{ProjectName\}-\$\{EnvironmentName\}-schedules/);
  assert.match(template, /ReconcileFinalRetrySchedule:[\s\S]*?cron\(5 16/);
  assert.match(template, /CheckTradingExitCode/);
  assert.match(template, /CheckSyncExitCode/);
});

test("거래·동기화 lease와 task family 환경변수가 실행기 이름과 일치한다", () => {
  for (const name of [
    "AUTOTRADE_AWS_TRADE_LEASE_MS",
    "AUTOTRADE_AWS_SYNC_LEASE_MS",
    "AUTOTRADE_AWS_LEASE_HEARTBEAT_MS",
    "AUTOTRADE_TASK_DEADLINE_MS",
    "AUTOTRADE_TASK_DEADLINE_GUARD_MS",
    "AUTOTRADE_EXPECTED_TASK_FAMILY"
  ]) {
    assert.match(template, new RegExp(name));
  }
  assert.equal(
    (template.match(/Value: aws-fargate/g) || []).length,
    2
  );
  assert.doesNotMatch(template, /AUTOTRADE_CLOUD_LEASE_MS/);
  const syncTask = template.slice(
    template.indexOf("  DataSyncTaskDefinition:"),
    template.indexOf("  StateMachineRole:")
  );
  assert.match(syncTask, /Cpu: "512"/);
  assert.match(syncTask, /Memory: "2048"/);
  assert.match(template, /AutotradeStateMachine:[\s\S]*?"TimeoutSeconds": 2500/);
  assert.match(template, /RunTradingCommand[\s\S]*?"TimeoutSeconds": 2400/);
  assert.match(template, /DataSyncStateMachine:[\s\S]*?"TimeoutSeconds": 9100/);
  assert.match(template, /RunDataSync[\s\S]*?"TimeoutSeconds": 9000/);
});

test("sync·audit은 거래용 SSM 제어값 없이 시작하고 주문 명령만 이를 강제한다", () => {
  const common = {
    AUTOTRADE_STATE_TABLE: "longview-state",
    AUTOTRADE_SNAPSHOT_BUCKET: "longview-snapshots"
  };
  assert.equal(awsResourceSettings({ ...common }, "sync").controlParameter, "");
  assert.equal(awsResourceSettings({ ...common }, "audit").controlParameter, "");
  assert.throws(
    () => awsResourceSettings({ ...common }, "auto"),
    /제어 파라미터/
  );
  assert.equal(
    awsResourceSettings(
      { ...common, AUTOTRADE_KILL_SWITCH_PARAMETER: "/longview/control" },
      "reconcile"
    ).controlParameter,
    "/longview/control"
  );
});

test("AWS OIDC workflow는 장기 AWS key 없이 고정 Action SHA만 사용한다", () => {
  for (const workflow of [
    deployWorkflow,
    bootstrapWorkflow,
    validateWorkflow
  ]) {
    assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
    for (const line of workflow
      .split(/\r?\n/)
      .filter((value) => value.trim().startsWith("uses:"))) {
      assert.match(line, /@[a-f0-9]{40}(?:\s|$)/);
    }
  }
  for (const workflow of [deployWorkflow, bootstrapWorkflow]) {
    assert.match(workflow, /permissions:[\s\S]*?id-token: write/);
  }
  assert.match(deployWorkflow, /npm run check/);
  assert.match(deployWorkflow, /imageTag=\$GITHUB_SHA/);
  assert.match(bootstrapWorkflow, /MIGRATE_GITHUB_STATE_TO_AWS/);
  assert.match(validateWorkflow, /pull_request:/);
  assert.match(validateWorkflow, /permissions:\s*\r?\n\s+contents: read/);
  assert.doesNotMatch(validateWorkflow, /id-token: write|secrets\./);
  assert.match(validateWorkflow, /- "tests\/\*\*"/);
  assert.match(validateWorkflow, /- "docs\/\*\*"/);
  assert.match(validateWorkflow, /npm run check/);
  assert.match(validateWorkflow, /cfn-lint==1\.39\.1/);
  assert.match(validateWorkflow, /docker build --pull/);
});

test("AWS OIDC trust는 보호된 GitHub environment에만 바인딩된다", () => {
  const deployRole = template.slice(
    template.indexOf("  GitHubDeployRole:"),
    template.indexOf("  GitHubBootstrapRole:")
  );
  const bootstrapRole = template.slice(
    template.indexOf("  GitHubBootstrapRole:"),
    template.indexOf("\nOutputs:")
  );

  for (const role of [deployRole, bootstrapRole]) {
    assert.match(
      role,
      /repo:\$\{GitHubRepository\}:environment:\$\{GitHubDeployEnvironment\}/
    );
  }
  assert.doesNotMatch(template, /ref:refs\/heads\//);
});

test("AWS 배포·bootstrap workflow는 동일한 보호 환경과 직렬화 계약을 사용한다", () => {
  for (const workflow of [deployWorkflow, bootstrapWorkflow]) {
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(
      workflow,
      /concurrency:\s*\r?\n\s+group: longview-aws-maintenance/
    );
    assert.match(workflow, /^\s+environment: aws-production$/m);
    assert.match(
      workflow,
      /test "\$STACK_NAME" = "longview-autotrade"/
    );
  }
  assert.match(bootstrapWorkflow, /permissions:[\s\S]*?actions: write/);
  assert.match(
    bootstrapWorkflow,
    /uses: actions\/checkout@[a-f0-9]{40}[\s\S]*?with:\s*\r?\n\s+ref: \$\{\{ github\.sha \}\}/
  );
});

test("CloudFormation 실행 역할은 IAM을 조회·제한적 PassRole만 할 수 있다", () => {
  const executionRole = template.slice(
    template.indexOf("  CloudFormationExecutionRole:"),
    template.indexOf("  GitHubDeployRole:")
  );
  const iamActions = [...executionRole.matchAll(/- iam:([A-Za-z*]+)/g)].map(
    ([, action]) => action
  );

  assert.ok(iamActions.length > 0);
  assert.deepEqual(
    iamActions.filter((action) => !/^(?:Get|List|PassRole)/.test(action)),
    []
  );

  const passRoleStatements = executionRole
    .split(/\r?\n(?=\s+- Sid: )/)
    .filter((statement) => statement.includes("iam:PassRole"));
  assert.ok(passRoleStatements.length > 0);
  for (const statement of passRoleStatements) {
    assert.doesNotMatch(statement, /Resource:\s*(?:-\s*)?["']?\*["']?/);
  }
});

test("GitHub 배포 역할은 bucket 조회와 prefix 제한 목록 권한을 분리한다", () => {
  const deployRole = template.slice(
    template.indexOf("  GitHubDeployRole:"),
    template.indexOf("  GitHubBootstrapRole:")
  );
  const statements = deployRole.split(/\r?\n(?=\s+- Sid: )/);
  const locateBucket = statements.find((statement) =>
    statement.includes("Sid: LocateDeploymentBucket")
  );
  const listPrefix = statements.find((statement) =>
    statement.includes("Sid: ListPrivateDeploymentPrefix")
  );

  assert.ok(locateBucket);
  assert.match(locateBucket, /s3:GetBucketLocation/);
  assert.doesNotMatch(locateBucket, /s3:ListBucket/);
  assert.ok(listPrefix);
  assert.match(listPrefix, /s3:ListBucket/);
  assert.doesNotMatch(listPrefix, /s3:GetBucketLocation/);
  assert.match(
    listPrefix,
    /Condition:[\s\S]*?s3:prefix:[\s\S]*?- deployment\/\*/
  );
});

test("retired legacy live workflow에는 예약·비밀·주문 실행이 없다", () => {
  assert.match(legacyWorkflow, /Retired GitHub live autotrade/);
  assert.doesNotMatch(legacyWorkflow, /schedule:/);
  assert.doesNotMatch(
    legacyWorkflow,
    /secrets\.|KIS_|AUTOTRADE_STATE_KEY|cloud-autotrade|aws-task\.mjs/
  );
});

test("컨테이너는 비밀·로컬 상태를 제외하고 존재하는 소스만 비root로 실행한다", async () => {
  assert.match(dockerfile, /^FROM node:22-bookworm-slim/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^\.autotrade$/m);
  assert.match(dockerignore, /^data\/dart-market$/m);
  for (const line of dockerfile
    .split(/\r?\n/)
    .filter((value) => value.startsWith("COPY --chown=node:node "))) {
    const tokens = line.trim().split(/\s+/);
    for (const item of tokens.slice(2, -1)) {
      await access(item);
    }
  }
});
