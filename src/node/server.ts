import express from 'express';
import type { Request, Response } from 'express';
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
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  authCounter++;
  return { shopId: MOCK_SHOP_ID, branchId: MOCK_BRANCH_ID };
}

const app = express();

app.get('/api/events/stream/', (req: Request, res: Response) => {
  const auth = authenticate(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Disable Nagle — push small SSE chunks immediately
  req.socket?.setNoDelay?.(true);

  const roomName = buildRoomName(auth.shopId, auth.branchId);

  // Pass res directly — no controller shim needed
  const client = addClient(res, roomName);
  sendEvent(client, 'connected', { clientId: client.id, room: roomName });

  req.on('close', () => {
    removeClient(client.id);
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', clients: getClientCount() });
});

export { app };
