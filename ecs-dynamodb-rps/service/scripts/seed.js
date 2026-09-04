// scripts/seed.js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../src/config.js';
import { buildItem, itemSizeBytes } from '../src/item.js';

export const PARTITIONS = 50;
export const ITEMS_PER_PARTITION = 20;
const BATCH = 25; // BatchWriteItem hard limit

const pad = (n) => String(n).padStart(2, '0');

export function seedItems() {
  const items = [];
  for (let p = 0; p < PARTITIONS; p++)
    for (let i = 0; i < ITEMS_PER_PARTITION; i++)
      items.push(buildItem({ pk: `feed-${pad(p)}`, sk: `item-${pad(i)}` }));
  return items;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const defaultSleep = (ms) => new Promise((res) => setTimeout(res, ms));

// DynamoDB expresses write throttling two ways: a 200 response carrying UnprocessedItems
// (handled by draining r.UnprocessedItems below), and a thrown exception when the whole
// request is rejected instead of partially accepted. Only the names below are throttling —
// anything else (ValidationException, ResourceNotFoundException, ...) must propagate so a
// real bug doesn't get retried into a timeout.
const THROTTLE_ERROR_NAMES = new Set(['ProvisionedThroughputExceededException', 'ThrottlingException']);

function isThrottlingError(err) {
  if (!err || typeof err !== 'object') return false;
  if (THROTTLE_ERROR_NAMES.has(err.name)) return true;
  return err?.$metadata?.httpStatusCode === 400 && THROTTLE_ERROR_NAMES.has(err.name);
}

/**
 * Writes every item via BatchWriteItem, retrying UnprocessedItems (the partial-throttle,
 * 200-response path) and thrown ProvisionedThroughputExceededException/ThrottlingException
 * (the whole-request-rejected path) with the same exponential backoff, retrying the same
 * pending batch either way. Throws if any items are still unprocessed after the final
 * attempt — a seed that silently drops items corrupts the capacity model it's supposed to
 * back (a short partition changes the feed Query's read-block cost). Returns the count
 * actually written.
 *
 * batchDelayMs paces batches between chunks so steady-state throughput stays near
 * provisioned capacity (25 WCU/s == one 25-item batch/s) instead of relying on burst
 * capacity, which drains and then throttles hard.
 */
export async function writeAll(
  doc,
  tableName,
  items,
  { attempts = 5, sleep = defaultSleep, onProgress, batchDelayMs = 1000 } = {},
) {
  let written = 0;
  const groups = chunk(items, BATCH);
  for (let g = 0; g < groups.length; g++) {
    let pending = groups[g];
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const r = await doc.send(new BatchWriteCommand({
          RequestItems: { [tableName]: pending.map((Item) => ({ PutRequest: { Item } })) },
        }));
        const un = r.UnprocessedItems?.[tableName] ?? [];
        pending = un.map((req) => req.PutRequest.Item);
      } catch (err) {
        if (!isThrottlingError(err)) throw err;
        // whole request rejected: pending is unchanged, retry it as-is
      }
      if (!pending.length) break;
      if (attempt < attempts - 1) await sleep(100 * 2 ** attempt);
    }
    if (pending.length) {
      const sample = pending.slice(0, 3).map((it) => `${it.pk}/${it.sk}`).join(', ');
      throw new Error(
        `seed incomplete: ${pending.length} item(s) remained unwritten after ${attempts} attempt(s) (e.g. ${sample})`,
      );
    }
    written += groups[g].length;
    onProgress?.(written, items.length);
    if (batchDelayMs && g < groups.length - 1) await sleep(batchDelayMs);
  }
  return written;
}

async function main() {
  const config = loadConfig();

  // ITEMS_PER_PARTITION and feedPageSize both feed the same capacity model: the feed Query reads
  // exactly one page per partition, and its cost (read blocks -> RCU) is derived assuming the
  // page size equals the partition size. Left unequal, e.g. 16 items rounds to 4 read blocks
  // instead of 5 (2.0 RCU instead of 2.5) — a 17% error that reads as a better-than-expected
  // measured ceiling rather than as a bug. Fail before any network client is constructed.
  if (ITEMS_PER_PARTITION !== config.feedPageSize)
    throw new Error(`FEED_PAGE_SIZE=${config.feedPageSize} != ITEMS_PER_PARTITION=${ITEMS_PER_PARTITION}; the 2.5 RCU feed coefficient assumes they are equal`);

  const items = seedItems();

  for (const it of items) {
    const size = itemSizeBytes(it);
    if (size < 900 || size > 1024)
      throw new Error(`item ${it.pk}/${it.sk} is ${size} B — outside the 900-1024 band the capacity model assumes`);
  }

  const base = new DynamoDBClient({
    region: config.region,
    // Default is 3: exhausted quickly under sustained throttling, throwing straight past
    // writeAll's own retry loop. Let the SDK's internal retries absorb transient throttles
    // too, on top of writeAll's batch-level retry/backoff.
    maxAttempts: 8,
    ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {}),
  });
  const doc = DynamoDBDocumentClient.from(base);

  const written = await writeAll(doc, config.tableName, items, {
    onProgress: (n, total) => process.stdout.write(`\rseeded ${n}/${total}`),
  });
  console.log(`\nseeded ${written} items into ${config.tableName}`);
  base.destroy();
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
