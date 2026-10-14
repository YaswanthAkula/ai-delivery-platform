import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Memory, AppError } from './memory.mjs';
import { OperationStore } from './operation-store.mjs';
import { CodexExecutor, createCodexRunner } from './codex-executor.mjs';
import { createReleaseClient } from './release-client.mjs';

async function readBody(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'JSON_REQUIRED', 'Use application/json');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 1000000) throw new AppError(413, 'BODY_TOO_LARGE', 'Operation exceeds request limit'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AppError(400, 'INVALID_JSON', 'Operation body must be valid JSON'); }
}
export class RuntimeWorker {
  constructor({ store, executor }) { this.store = store; this.executor = executor; }
  async tick() {
    const operation = this.store.claim(); if (!operation) return false;
    try {
      const { result, artifact } = await this.executor.execute(operation);
      this.store.complete(operation.id, result, artifact);
    } catch (error) {
      this.store.fail(operation.id, error instanceof AppError ? error.code : 'EXECUTION_FAILED', error.artifact);
    }
    return true;
  }
}
export function createRuntimeApp({ store, repositories, token }) {
  if (!token || token.length < 32) throw new Error('CODING_RUNTIME_TOKEN must contain at least 32 characters');
  return createServer(async (req, res) => {
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(payload)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError(401, 'UNAUTHORIZED', 'Valid runtime bearer token required');
      if (req.method === 'POST' && path === '/operations') {
        const value = await readBody(req);
        if (!value || !Object.hasOwn(repositories, value.repository)) throw new AppError(403, 'REPOSITORY_NOT_ALLOWED', 'Repository is not allowlisted');
        const operation = store.submit(req.headers['idempotency-key'], value);
        return send(202, { id: operation.id });
      }
      const match = path.match(/^\/operations\/([a-f0-9-]{36})(\/evidence)?$/);
      if (!match || req.method !== 'GET') throw new AppError(404, 'NOT_FOUND', 'Route not found');
      const operation = store.get(match[1]);
      if (match[2]) {
        if (!operation.artifact) throw new AppError(404, 'EVIDENCE_NOT_READY', 'Evidence is not available');
        return send(200, JSON.parse(operation.artifact));
      }
      return send(200, { id: operation.id, status: operation.status, ...(operation.result ? { result: operation.result } : {}), ...(operation.error_code ? { error: operation.error_code, retryable: false } : {}) });
    } catch (error) { send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : 'Internal runtime error' }); }
  });
}

// One supervisor-owned runtime process per database. Never recover live operations from another instance.
export function acquireRuntimeLock(databasePath) {
  const path = resolve(databasePath) + '.lock'; mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch { throw new Error('Runtime lock exists; confirm the previous service/process group is stopped before removing its lock'); }
  writeFileSync(descriptor, String(process.pid)); closeSync(descriptor);
  return () => unlinkSync(path);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.RUNTIME_REPOSITORIES_FILE || !process.env.RUNTIME_PUBLIC_URL) throw new Error('Configure RUNTIME_REPOSITORIES_FILE and RUNTIME_PUBLIC_URL');
  const repositories = JSON.parse(readFileSync(process.env.RUNTIME_REPOSITORIES_FILE, 'utf8'));
  const databasePath = process.env.RUNTIME_DATABASE_PATH ?? './runtime-data/operations.sqlite';
  const unlock = acquireRuntimeLock(databasePath);
  let memory, server;
  try {
    memory = new Memory(databasePath); const store = new OperationStore(memory); store.recoverInterrupted();
    const release = process.env.RELEASE_SERVICE_URL && process.env.RELEASE_SERVICE_TOKEN ? createReleaseClient({ url: process.env.RELEASE_SERVICE_URL, token: process.env.RELEASE_SERVICE_TOKEN }) : undefined;
    const executor = new CodexExecutor({ store, repositories, workspaceRoot: process.env.RUNTIME_WORKSPACE_ROOT ?? './runtime-data/workspaces', publicUrl: process.env.RUNTIME_PUBLIC_URL, codex: createCodexRunner({ executable: process.env.CODEX_EXECUTABLE ?? 'codex', model: process.env.CODING_MODEL }), release });
    server = createRuntimeApp({ store, repositories, token: process.env.CODING_RUNTIME_TOKEN });
    const worker = new RuntimeWorker({ store, executor });
    const port = Number(process.env.RUNTIME_PORT ?? 3100);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_PORT must be 1–65535');
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.RUNTIME_HOST ?? '127.0.0.1', () => { server.removeListener('error', reject); console.log(`Coding runtime listening on port ${port}`); done(); });
    });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; server.close(); });
    while (!stopping) { if (!await worker.tick()) await new Promise(done => setTimeout(done, 1000)); }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(() => done())); }
    memory?.close(); unlock();
  }
}
