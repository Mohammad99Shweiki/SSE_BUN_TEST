/**
 * Node-compatible adapter that bridges Node's http module to the
 * Web-standard fetch(Request) → Response pattern used by the SSE server.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type FetchHandler = (req: Request) => Response | Promise<Response>;

export interface NodeServer {
  port: number;
  stop(closeConnections?: boolean): void;
}

function toWebRequest(incoming: IncomingMessage, port: number): Request {
  const url = `http://127.0.0.1:${port}${incoming.url || '/'}`;
  const headers = new Headers();
  for (const [key, val] of Object.entries(incoming.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }
  return new Request(url, { method: incoming.method || 'GET', headers });
}

async function pipeResponse(
  webRes: Response,
  nodeRes: ServerResponse,
  nodeReq: IncomingMessage,
): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));

  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  const onClose = () => reader.cancel();
  nodeReq.on('close', onClose);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!nodeRes.writable) break;
      nodeRes.write(value);
    }
  } catch {
    // stream cancelled or client disconnected
  } finally {
    nodeReq.off('close', onClose);
    nodeRes.end();
  }
}

export function serve(options: {
  port: number;
  fetch: FetchHandler;
}): Promise<NodeServer> {
  return new Promise((resolve) => {
    let port = options.port;

    const server = createServer(async (req, res) => {
      try {
        const webReq = toWebRequest(req, port);
        const webRes = await options.fetch(webReq);
        await pipeResponse(webRes, res, req);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });

    server.listen(options.port, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) port = addr.port;
      resolve({
        port,
        stop(closeConnections) {
          if (closeConnections) server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
