/**
 * SSE Load Test — Node-compatible version
 *
 * Usage:
 *   npx tsx sseLoadTest.node.ts
 *   # or via script:
 *   npm run test:node
 *
 * Environment overrides:
 *   LOAD_TEST_CONNECTIONS=25000   — number of concurrent connections
 *   LOAD_TEST_RAMP_UP_MS=30000   — ramp-up duration
 *   LOAD_TEST_HOLD_MS=10000      — hold duration after ramp-up
 *   THROUGHPUT_DURATION_MS=60000  — throughput test duration
 *   MSG_PER_SEC=2                 — broadcast rate during throughput test
 */
import { handleRequest } from './src/server';
import {
  broadcast,
  buildRoomName,
  closeAllClients,
  getClientCount,
} from './src/sse';
import { serve } from './src/nodeAdapter';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TOTAL_CONNECTIONS = Number(process.env.LOAD_TEST_CONNECTIONS) || 15000;
const RAMP_UP_MS = Number(process.env.LOAD_TEST_RAMP_UP_MS) || 30000;
const HOLD_DURATION_MS = Number(process.env.LOAD_TEST_HOLD_MS) || 10000;
const MESSAGE_TIMEOUT_MS = 60_000;

const MOCK_SHOP_ID = 'a0000000-0000-0000-0000-000000000001';
const MOCK_BRANCH_ID = 'b0000000-0000-0000-0000-000000000001';
const SSEEventClassEnum = { CATEGORY: 'category' } as const;
const SSEEventActionEnum = { CREATED: 'created' } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type EventHandler = (data: Record<string, unknown>) => void;

interface SSEConn {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: AbortController;
  listeners: Map<string, EventHandler[]>;
  closed: boolean;
  connectTime: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const decoder = new TextDecoder();

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatStats(values: number[]): string {
  if (values.length === 0) return 'N/A';
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return [
    `min=${sorted[0]}ms`,
    `avg=${avg.toFixed(1)}ms`,
    `p95=${percentile(sorted, 95)}ms`,
    `max=${sorted[sorted.length - 1]}ms`,
  ].join('  ');
}

function getMemoryMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function startReadLoop(conn: SSEConn): void {
  let buffer = '';
  const pump = async () => {
    try {
      while (!conn.closed) {
        const { done, value } = await conn.reader.read();
        if (done) break;
        buffer += decoder.decode(value!, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (!part.trim()) continue;
          let event = '';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (event && data) {
            const handlers = conn.listeners.get(event);
            if (handlers) {
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                for (const h of [...handlers]) h(parsed);
              } catch {}
            }
          }
        }
      }
    } catch {}
  };
  pump();
}

function waitForSSEEvent(
  conn: SSEConn,
  eventName: string,
  timeoutMs = MESSAGE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    const handler: EventHandler = () => {
      clearTimeout(timeout);
      const handlers = conn.listeners.get(eventName);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      resolve(true);
    };
    if (!conn.listeners.has(eventName)) conn.listeners.set(eventName, []);
    conn.listeners.get(eventName)!.push(handler);
  });
}

async function createConnection(port: number): Promise<SSEConn | null> {
  try {
    const abort = new AbortController();
    const conn: SSEConn = {
      reader: null as any,
      abort,
      listeners: new Map(),
      closed: false,
      connectTime: 0,
    };

    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/events/stream/`, {
      headers: {
        Authorization: 'Bearer mock-token',
        Accept: 'text/event-stream',
      },
      signal: abort.signal,
    });

    if (res.status !== 200) return null;
    conn.reader = res.body!.getReader();
    startReadLoop(conn);

    const ok = await waitForSSEEvent(conn, 'connected', 30_000);
    if (!ok) return null;
    conn.connectTime = Date.now() - t0;
    return conn;
  } catch {
    return null;
  }
}

function cleanup(conns: SSEConn[]): void {
  for (const c of conns) {
    c.closed = true;
    c.abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Server (Node adapter instead of Bun.serve)
// ---------------------------------------------------------------------------
const server = await serve({ port: 0, fetch: handleRequest });
const port = server.port;
console.log(`SSE Load Test Server on port ${port}\n`);

let allPassed = true;

// ---------------------------------------------------------------------------
// Test 1: Mass connections + single broadcast
// ---------------------------------------------------------------------------
async function testMassConnections(): Promise<SSEConn[]> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST 1: ${TOTAL_CONNECTIONS} concurrent connections + broadcast`);
  console.log(`${'='.repeat(60)}`);

  const conns: SSEConn[] = [];
  const errors: string[] = [];
  const memoryBefore = getMemoryMB();

  // Ramp up — 500 per batch for 25k scale
  const BATCH = 500;
  const delayBetweenBatches = RAMP_UP_MS / (TOTAL_CONNECTIONS / BATCH);
  const t0 = Date.now();

  for (let start = 0; start < TOTAL_CONNECTIONS; start += BATCH) {
    const end = Math.min(start + BATCH, TOTAL_CONNECTIONS);
    const batch = [];
    for (let i = start; i < end; i++) {
      batch.push(
        createConnection(port).then((c) => {
          if (c) conns.push(c);
          else errors.push(`Connection ${i} failed`);
        }),
      );
    }
    await Promise.all(batch);

    const elapsed = Date.now() - t0;
    console.log(
      `  Ramp-up: ${conns.length}/${end} connected (${errors.length} errors) [${elapsed}ms]`,
    );

    if (start + BATCH < TOTAL_CONNECTIONS) {
      await new Promise((r) => setTimeout(r, delayBetweenBatches));
    }
  }

  const rampUpMs = Date.now() - t0;
  console.log(`\n  Ramp-up complete in ${rampUpMs}ms: ${conns.length} connected, ${errors.length} errors`);

  // Hold
  console.log(`  Holding ${HOLD_DURATION_MS}ms...`);
  await new Promise((r) => setTimeout(r, HOLD_DURATION_MS));
  console.log(`  Server reports ${getClientCount()} active clients`);

  // Broadcast
  const broadcastRoom = buildRoomName(MOCK_SHOP_ID, MOCK_BRANCH_ID);
  const broadcastPayload = {
    type: 'event' as const,
    data: {
      id: 'c0000000-0000-0000-0000-000000000001',
      name: 'Load Test Category',
    },
    metadata: {
      entity: SSEEventClassEnum.CATEGORY,
      action: SSEEventActionEnum.CREATED,
      shopId: MOCK_SHOP_ID,
      branchId: MOCK_BRANCH_ID,
      timestamp: new Date(),
      triggeredBy: null,
    },
  };

  const receivePromises = conns.map((c) => waitForSSEEvent(c, 'entity-event', MESSAGE_TIMEOUT_MS));
  const broadcastStart = Date.now();
  const sentCount = broadcast(broadcastRoom, broadcastPayload);
  const results = await Promise.all(receivePromises);
  const broadcastMs = Date.now() - broadcastStart;

  const received = results.filter(Boolean).length;
  const connectTimes = conns.map((c) => c.connectTime);
  const memoryAfter = getMemoryMB();

  console.log(`
--- TEST 1 RESULTS ---
Connections:  ${conns.length} successful, ${errors.length} failed
Connect:      ${formatStats(connectTimes)}
Broadcast:    sent to ${sentCount}/${conns.length} clients
  Received:   ${received}/${conns.length} in ${broadcastMs}ms
Memory:       ${memoryBefore}MB -> ${memoryAfter}MB (+${memoryAfter - memoryBefore}MB)
`);

  if (errors.length > 0) {
    console.log(`  Errors (first 5): ${errors.slice(0, 5).join(', ')}`);
  }

  // Assertions
  const connOk = conns.length > 0;
  const errorRateOk = errors.length < TOTAL_CONNECTIONS * 0.05;
  console.log(`  ASSERT connections > 0: ${connOk ? 'PASS' : 'FAIL'}`);
  console.log(`  ASSERT error rate < 5%: ${errorRateOk ? 'PASS' : 'FAIL'}`);
  if (!connOk || !errorRateOk) allPassed = false;

  return conns;
}

// ---------------------------------------------------------------------------
// Test 2: Sustained throughput
// ---------------------------------------------------------------------------
async function testThroughput(existingConns: SSEConn[]): Promise<void> {
  const TEST_DURATION_MS = Number(process.env.THROUGHPUT_DURATION_MS) || 60_000;
  const MSG_PER_SEC = Number(process.env.MSG_PER_SEC) || 2;

  const conns = existingConns.filter((c) => !c.closed);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST 2: Throughput — ${conns.length} connections (reused), ${MSG_PER_SEC} msg/sec for ${TEST_DURATION_MS / 1000}s`);
  console.log(`${'='.repeat(60)}`);

  const memoryBefore = getMemoryMB();
  console.log(`  Reusing ${conns.length} connections from Test 1`);

  const broadcastRoom = buildRoomName(MOCK_SHOP_ID, MOCK_BRANCH_ID);

  let messageId = 0;
  let totalDelivered = 0;
  const deliveryLatencies: number[] = [];
  const messageReceivedCount = new Map<number, number>();

  // Attach persistent listeners
  for (const conn of conns) {
    const handler: EventHandler = (parsed) => {
      const msgData = parsed.data as { messageId?: number; timestamp?: number };
      if (msgData.messageId !== undefined && msgData.timestamp !== undefined) {
        const latency = Date.now() - msgData.timestamp;
        deliveryLatencies.push(latency);
        const count = messageReceivedCount.get(msgData.messageId) || 0;
        messageReceivedCount.set(msgData.messageId, count + 1);
        totalDelivered++;
      }
    };
    if (!conn.listeners.has('entity-event')) conn.listeners.set('entity-event', []);
    conn.listeners.get('entity-event')!.push(handler);
  }

  console.log(`  Broadcasting at ${MSG_PER_SEC} msg/sec...`);

  const testStart = Date.now();
  const intervalMs = 1000 / MSG_PER_SEC;

  while (Date.now() - testStart < TEST_DURATION_MS) {
    messageId++;
    const payload = {
      type: 'event' as const,
      data: {
        id: `c0000000-0000-0000-0000-${String(messageId).padStart(12, '0')}`,
        messageId,
        timestamp: Date.now(),
        name: `Throughput Test Message ${messageId}`,
      },
      metadata: {
        entity: SSEEventClassEnum.CATEGORY,
        action: SSEEventActionEnum.CREATED,
        shopId: MOCK_SHOP_ID,
        branchId: MOCK_BRANCH_ID,
        timestamp: new Date(),
        triggeredBy: null,
      },
    };
    broadcast(broadcastRoom, payload);

    const elapsed = Date.now() - testStart;
    const nextTime = messageId * intervalMs;
    const delay = Math.max(0, nextTime - elapsed);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  const broadcastDuration = (Date.now() - testStart) / 1000;

  // Wait for client-side read loops to process enqueued data
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const avgDeliveriesPerMessage =
    messageId > 0 && conns.length > 0 ? totalDelivered / messageId / conns.length : 0;
  const messagesPerSecond = messageId / broadcastDuration;
  const deliveriesPerSecond = totalDelivered / broadcastDuration;
  const memoryAfter = getMemoryMB();

  console.log(`
--- TEST 2 RESULTS ---
Connections:           ${conns.length} active
Broadcast Duration:    ${broadcastDuration.toFixed(1)}s
Messages Broadcast:    ${messageId}
Messages/sec:          ${messagesPerSecond.toFixed(1)}
Total Deliveries:      ${totalDelivered.toLocaleString()}
Deliveries/sec:        ${deliveriesPerSecond.toFixed(1)}
Avg Delivery Rate:     ${(avgDeliveriesPerMessage * 100).toFixed(2)}% per message
Delivery Latency:      ${formatStats(deliveryLatencies)}
Memory:                ${memoryBefore}MB -> ${memoryAfter}MB (+${memoryAfter - memoryBefore}MB)
`);

  // Assertions
  const connOk = conns.length > existingConns.length * 0.95;
  const msgOk = messageId > 0;
  const deliveryOk = avgDeliveriesPerMessage > 0.5;
  console.log(`  ASSERT >95% connected: ${connOk ? 'PASS' : 'FAIL'} (${conns.length}/${existingConns.length})`);
  console.log(`  ASSERT messages sent: ${msgOk ? 'PASS' : 'FAIL'} (${messageId})`);
  console.log(`  ASSERT >50% delivery: ${deliveryOk ? 'PASS' : 'FAIL'} (${(avgDeliveriesPerMessage * 100).toFixed(1)}%)`);
  if (!connOk || !msgOk || !deliveryOk) allPassed = false;

  cleanup(conns);
  closeAllClients();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
try {
  const conns = await testMassConnections();
  await testThroughput(conns);
} finally {
  server.stop(true);
}

console.log(`\n${'='.repeat(60)}`);
console.log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
console.log(`${'='.repeat(60)}\n`);

process.exit(allPassed ? 0 : 1);
