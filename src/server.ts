import {
  addClient,
  removeClient,
  buildRoomName,
  sendEvent,
  getClientCount,
} from './sse';

// --- Config ---
const MOCK_SHOP_ID = 'a0000000-0000-0000-0000-000000000001';
const MOCK_BRANCH_ID = 'b0000000-0000-0000-0000-000000000001';

let authCounter = 0;

// --- Auth (simplified mock) ---
interface AuthContext {
  userId: string;
  shopId: string;
  branchId: string;
  roleId: string;
  deviceId: string;
}

function authenticate(req: Request): AuthContext | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  authCounter++;
  return {
    userId: `u0000000-0000-0000-0000-${String(authCounter).padStart(12, '0')}`,
    shopId: MOCK_SHOP_ID,
    branchId: MOCK_BRANCH_ID,
    roleId: `r0000000-0000-0000-0000-${String(authCounter).padStart(12, '0')}`,
    deviceId: `d0000000-0000-0000-0000-${String(authCounter).padStart(12, '0')}`,
  };
}

// --- SSE handler ---
function handleSSEStream(req: Request): Response {
  const auth = authenticate(req);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const roomName = buildRoomName(auth.shopId, auth.branchId);

  let client: ReturnType<typeof addClient>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = addClient(controller, roomName);
      sendEvent(client, 'connected', { clientId: client.id, room: roomName });
    },
    cancel() {
      removeClient(client.id);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// --- Request router ---
function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/api/events/stream/') {
    return handleSSEStream(req);
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok', clients: getClientCount() });
  }

  return new Response('Not Found', { status: 404 });
}

// --- Exports for testing ---
export { handleRequest, MOCK_SHOP_ID, MOCK_BRANCH_ID };
export { broadcast, buildRoomName, closeAllClients, getClientCount } from './sse';

// --- Start server if run directly ---
if (import.meta.main) {
  const PORT = Number(process.env.PORT) || 3000;
  const server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
    // no idleTimeout — 5s heartbeat keeps connections alive under default 10s
  });
  console.log(`SSE server running on http://localhost:${server.port}`);
  console.log(`  Stream:  GET /api/events/stream/`);
  console.log(`  Health:  GET /health`);
}
