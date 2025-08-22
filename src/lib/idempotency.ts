import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.DDB_TABLE;
const TTL_DAYS = 90;

export async function checkIdempotency(path: string, mtime: number): Promise<boolean> {
  if (!TABLE_NAME) {
    // If no table configured, fall back to S3 HEAD check
    return false;
  }

  try {
    const response = await client.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          path,
          mtime
        })
      })
    );

    return !!response.Item;
  } catch (error) {
    console.warn('Failed to check idempotency:', error);
    return false;
  }
}

export async function markProcessed(path: string, mtime: number): Promise<void> {
  if (!TABLE_NAME) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = now + (TTL_DAYS * 24 * 60 * 60);

  try {
    await client.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall({
          path,
          mtime,
          processedAt: now,
          expiresAt: ttl
        })
      })
    );
  } catch (error) {
    console.warn('Failed to mark as processed:', error);
  }
}
