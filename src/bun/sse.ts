export interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  rooms: Set<string>;
  connectedAt: number;
  closed: boolean;
}

export interface BroadcastPayload {
  type: 'event';
  data: Record<string, unknown>;
  metadata: {
    entity: string;
    action: string;
    shopId: string;
    branchId: string;
    timestamp: Date;
    triggeredBy: string | null;
  };
}

const rooms = new Map<string, Set<string>>();
const clients = new Map<string, SSEClient>();
const encoder = new TextEncoder();
let clientIdCounter = 0;

export function buildRoomName(shopId: string, branchId: string): string {
  return `${shopId}:${branchId}`;
}

export function addClient(
  controller: ReadableStreamDefaultController<Uint8Array>,
  roomName: string,
): SSEClient {
  const id = `client_${++clientIdCounter}`;
  const client: SSEClient = {
    id,
    controller,
    rooms: new Set([roomName]),
    connectedAt: Date.now(),
    closed: false,
  };

  clients.set(id, client);

  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  rooms.get(roomName)!.add(id);

  return client;
}

export function removeClient(clientId: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  client.closed = true;

  for (const room of client.rooms) {
    const roomClients = rooms.get(room);
    if (roomClients) {
      roomClients.delete(clientId);
      if (roomClients.size === 0) {
        rooms.delete(room);
      }
    }
  }

  clients.delete(clientId);
}

export function sendEvent(client: SSEClient, event: string, data: unknown): boolean {
  if (client.closed) return false;
  try {
    client.controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    return true;
  } catch {
    client.closed = true;
    return false;
  }
}

export async function broadcast(roomName: string, payload: BroadcastPayload): Promise<number> {
  const roomClients = rooms.get(roomName);
  if (!roomClients) return 0;

  const eventBytes = encoder.encode(`event: entity-event\ndata: ${JSON.stringify(payload)}\n\n`);
  let sentCount = 0;
  const BATCH = 500;

  for (const clientId of roomClients) {
    const client = clients.get(clientId);
    if (!client || client.closed) continue;
    try {
      client.controller.enqueue(eventBytes);
      sentCount++;
      if (sentCount % BATCH === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    } catch {
      client.closed = true;
    }
  }

  return sentCount;
}

export function closeAllClients(): void {
  for (const [, client] of clients) {
    client.closed = true;
    try {
      client.controller.close();
    } catch {}
  }
  clients.clear();
  rooms.clear();
  clientIdCounter = 0;
}

export function getClientCount(): number {
  return clients.size;
}
