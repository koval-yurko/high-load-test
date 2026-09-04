// src/dynamo.js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export function createRepo(config) {
  const base = new DynamoDBClient({
    region: config.region,
    maxAttempts: 3,
    ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {}),
  });
  const doc = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
  const Table = config.tableName;

  return {
    async getItem(pk, sk) {
      const r = await doc.send(new GetCommand({ TableName: Table, Key: { pk, sk }, ConsistentRead: false }));
      return r.Item ?? null;
    },
    async putItem(item) {
      await doc.send(new PutCommand({ TableName: Table, Item: item }));
      return item;
    },
    async queryFeed(pk, limit) {
      const r = await doc.send(new QueryCommand({
        TableName: Table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        Limit: limit,
        // Eventually consistent: 0.5 RCU per 4 KB instead of 1. The capacity
        // model in the spec assumes this. Do not change without re-deriving it.
        ConsistentRead: false,
      }));
      return r.Items ?? [];
    },
    destroy() { base.destroy(); },
  };
}
