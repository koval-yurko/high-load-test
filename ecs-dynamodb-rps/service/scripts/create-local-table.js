// scripts/create-local-table.js
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { loadConfig } from '../src/config.js';

/**
 * The local twin of the `items` table declared in infra/main/dynamodb.tf. The key schema is
 * duplicated there and here on purpose — the local flow must not need Terraform, AWS credentials or
 * a network — so the two can drift. test/create-local-table.test.js pins this side; the comment in
 * infra/main/dynamodb.tf points back here. Change one, change both.
 *
 * Two deliberate differences from the deployed table:
 *   - PAY_PER_REQUEST, not PROVISIONED. Provisioned capacity on DynamoDB Local buys nothing: it does
 *     not meter or throttle, so the only thing a capacity number could produce here is the false
 *     impression that a local run says something about the capacity model. It does not.
 *   - No TTL. Deletion is asynchronous even in AWS (see the comment in dynamodb.tf), so it cannot
 *     keep a table small inside a dev loop, and the seeded items carry no expires_at anyway.
 */
export function tableSpec(tableName) {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  };
}

/**
 * Refuse to run against anything but an explicit local endpoint. Without this, a shell that never
 * loaded .env — or one that did — would have this script create a real table in the configured AWS
 * account, since the SDK falls back to ambient credentials and region. The repo's .envrc guards
 * credentials the same way: fail loudly rather than silently doing the expensive thing.
 */
export function assertLocalEndpoint(config) {
  if (!config.dynamoEndpoint)
    throw new Error(
      'DYNAMO_ENDPOINT is not set. This script only creates tables on DynamoDB Local — the deployed ' +
      'table is created by `terraform -chdir=infra/main apply`, never from here. Start the container ' +
      'and retry (see "Run it locally" in the project README):\n' +
      '  docker compose -f docker-compose.test.yml up -d\n' +
      '  export DYNAMO_ENDPOINT=http://localhost:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local\n' +
      '  npm run table:local',
    );
  return config.dynamoEndpoint;
}

/** Returns 'created' or 'exists' — re-running is a no-op, so the local loop stays copy-pasteable. */
export async function createLocalTable(client, tableName) {
  try {
    await client.send(new CreateTableCommand(tableSpec(tableName)));
    return 'created';
  } catch (err) {
    if (err.name === 'ResourceInUseException') return 'exists';
    throw err;
  }
}

async function main() {
  const config = loadConfig();
  const endpoint = assertLocalEndpoint(config);

  // No credential defaulting here on purpose. DynamoDB Local accepts any credentials but the SDK
  // still requires some to sign with, and `npm run seed` and `npm start` both hit the same wall —
  // neither defaults them either. Special-casing this one script would make it work in a shell
  // where the next two commands fail with a confusing CredentialsProviderError. The local flow
  // exports dummy credentials once, up front; see the README's "Run it locally".
  const client = new DynamoDBClient({ region: config.region, endpoint });
  const outcome = await createLocalTable(client, config.tableName);
  client.destroy();

  console.log(outcome === 'created'
    ? `created table ${config.tableName} at ${endpoint}`
    : `table ${config.tableName} already exists at ${endpoint}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
