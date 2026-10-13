import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Memory, AppError, requireText } from './memory.mjs';
import { createPlanner } from './planner.mjs';
import { DeliveryStore } from './delivery-store.mjs';

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}
function authorized(header, token) {
  const supplied = Buffer.from(header ?? ''); const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'JSON_REQUIRED', 'Use application/json');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new AppError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AppError(400, 'INVALID_JSON', 'Body must be a JSON object'); }
}
export function createApp({ memory, planner, token, maxPlanningTurns = 100, delivery = new DeliveryStore(memory) }) {
  if (!token || token.length < 32) throw new Error('APP_AUTH_TOKEN must contain at least 32 characters');
  const locks = new Set();
  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(payload));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/health' && req.method === 'GET') return send(200, { status: 'ok' });
      if (!authorized(req.headers.authorization, token)) throw new AppError(401, 'UNAUTHORIZED', 'Valid bearer token required');
      if (pathname === '/projects') {
        if (req.method === 'GET') return send(200, { projects: memory.list() });
        if (req.method === 'POST') { const value = await body(req); return send(201, memory.create(value.name, value.idea)); }
      }
      const match = pathname.match(/^\/projects\/([a-f0-9-]+)(?:\/(messages|specifications|approve|delivery|delivery\/resume))?$/);
      if (!match) throw new AppError(404, 'NOT_FOUND', 'Route not found');
      const [, id, action] = match;
      let project = memory.project(id);
      if (!action && req.method === 'GET') return send(200, { ...project, usage: memory.tokens(id), specifications: memory.specs(id) });
      if (action === 'messages' && req.method === 'GET') return send(200, { messages: memory.history(id) });
      if (action === 'specifications' && req.method === 'GET') return send(200, { specifications: memory.specs(id) });
      if (action === 'delivery' && req.method === 'GET') return send(200, { runs: delivery.forProject(id) });
      if (req.method !== 'POST') throw new AppError(404, 'NOT_FOUND', 'Route not found');
      const value = await body(req);
      project = memory.project(id);
      if (locks.has(id)) throw new AppError(409, 'PROJECT_BUSY', 'A planning turn is already running');
      if (action === 'specifications') return send(201, memory.saveSpec(id, value));
      if (action === 'approve') return send(200, memory.approve(id, value.version, value.expectedRevision, value.acknowledgeAssumptions));
      if (action === 'delivery') return send(202, delivery.start(id, value));
      if (action === 'delivery/resume') return send(200, delivery.resume(id, value.runId));
      if (action !== 'messages') throw new AppError(404, 'NOT_FOUND', 'Route not found');
      if (project.stage !== 'planning') throw new AppError(409, 'PLAN_FROZEN', 'Approved project cannot be replanned without a change request');
      const input = requireText(value.content, 'content');
      const messages = memory.history(id);
      if (messages.filter(item => item.role === 'user').length >= maxPlanningTurns) throw new AppError(409, 'TURN_LIMIT', 'Project planning turn limit reached');
      locks.add(id);
      try {
        const result = await planner.plan({ project, messages, specification: memory.specs(id).at(-1)?.content, input });
        memory.usage(id, planner.model, result.usage);
        return send(200, memory.commitTurn(id, project.revision, input, result.reply, result.specification));
      } catch (error) {
        if (error.usage) memory.usage(id, planner.model, error.usage);
        throw error;
      } finally { locks.delete(id); }
    } catch (error) {
      send(error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof AppError ? error.message : 'Internal server error'
      });
    }
  });
  server.requestTimeout = 75000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.APP_AUTH_TOKEN;
  if (!token || token.length < 32) throw new Error('Set APP_AUTH_TOKEN (at least 32 characters) before starting');
  const port = positiveInteger(process.env.PORT, 3000, 'PORT');
  const turns = positiveInteger(process.env.MAX_PLANNING_TURNS, 100, 'MAX_PLANNING_TURNS');
  const output = positiveInteger(process.env.PLANNER_MAX_OUTPUT_TOKENS, 3000, 'PLANNER_MAX_OUTPUT_TOKENS');
  const memory = new Memory(process.env.DATABASE_PATH ?? './data/platform.sqlite');
  const planner = createPlanner({ apiKey: process.env.OPENAI_API_KEY, model: process.env.PLANNER_MODEL, maxOutputTokens: output });
  const server = createApp({ memory, planner, token, maxPlanningTurns: turns });
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Planning API listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { memory.close(); process.exit(0); }));
}
