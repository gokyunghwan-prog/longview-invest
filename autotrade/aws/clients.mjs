import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

function region(value) {
  const normalized = String(value || "").trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(normalized)) {
    throw new TypeError("AWS_REGION이 올바르지 않습니다.");
  }
  return normalized;
}

export function createAwsClients({
  awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  maxAttempts = 3
} = {}) {
  const resolvedRegion = region(awsRegion);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError("AWS SDK maxAttempts는 1~5여야 합니다.");
  }
  const shared = { region: resolvedRegion, maxAttempts };
  const lowLevelDynamo = new DynamoDBClient(shared);
  return {
    region: resolvedRegion,
    dynamo: DynamoDBDocumentClient.from(lowLevelDynamo, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: false
      }
    }),
    s3: new S3Client(shared),
    secrets: new SecretsManagerClient(shared),
    ssm: new SSMClient(shared),
    destroy() {
      lowLevelDynamo.destroy();
      this.s3.destroy();
      this.secrets.destroy();
      this.ssm.destroy();
    }
  };
}
