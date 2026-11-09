'use strict';
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

// No maxAttempts here: the SDK reads AWS_MAX_ATTEMPTS from the environment, which is the
// sdk_max_attempts knob. Eventually consistent reads cost 0.5 RCU per 4 KB; the sizing
// arithmetic assumes it.
function createRepo({ tableName }, doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
  return {
    async getItem(pk, sk) {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: false }));
      return r.Item ?? null;
    },
    // Pages past the 1 MB Query limit, so a bigger seed keeps raising the route's cost.
    async queryAll(pk) {
      const items = [];
      let ExclusiveStartKey;
      do {
        const r = await doc.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ConsistentRead: false,
          ExclusiveStartKey,
        }));
        items.push(...(r.Items ?? []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },
  };
}

module.exports = { createRepo };
