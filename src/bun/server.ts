import {
  addClient,
  removeClient,
  buildRoomName,
  sendEvent,
  getClientCount,
} from './sse';

const MOCK_SHOP_ID = 'a0000000-0000-0000-0000-000000000001';
const MOCK_BRANCH_ID = 'b0000000-0000-0000-0000-000000000001';

let authCounter = 0;

function authenticate(req: Request): { shopId: string; branchId: string } | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  authCounter++;
  return { shopId: MOCK_SHOP_ID, branchId: MOCK_BRANCH_ID };
}

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

  const stream = new ReadableStream({
    type: 'direct',
    pull(controller: ReadableStreamDirectController) {
      client = addClient(controller, roomName);
      sendEvent(client, 'connected', { clientId: client.id, room: roomName });
      // Keep stream open until client disconnects
      return new Promise<void>(() => {});
    },
  } as any);

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

export function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/api/events/stream/') {
    return handleSSEStream(req);
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok', clients: getClientCount() });
  }

  return new Response('Not Found', { status: 404 });
}
