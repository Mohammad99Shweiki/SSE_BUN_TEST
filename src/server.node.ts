/**
 * Standalone Node server entry point.
 *
 * Usage:
 *   npx tsx src/server.node.ts
 *   # or via script:
 *   npm run start:node
 */
import { handleRequest } from './server';
import { serve } from './nodeAdapter';

const PORT = Number(process.env.PORT) || 3000;
const server = await serve({ port: PORT, fetch: handleRequest });
console.log(`SSE server running on http://localhost:${server.port}`);
console.log(`  Stream:  GET /api/events/stream/`);
console.log(`  Health:  GET /health`);
