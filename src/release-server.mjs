import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Memory, AppError } from './memory.mjs';
import { acquireRuntimeLock } from './runtime-server.mjs';
import { GitHubApi } from './github-release.mjs';
import { ReleaseStore } from './release-store.mjs';
import { ReleaseEngine } from './release-engine.mjs';

async function body(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError(415, 'JSON_REQUIRED', 'Use application/json');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16000000) throw new AppError(413, 'BODY_TOO_LARGE', 'Release snapshot exceeds limit'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AppError(400, 'INVALID_JSON', 'Valid JSON snapshot required'); }
}
export function createReleaseApp({ store, repositories, token }) {
  if (!token || token.length < 32) throw new Error('RELEASE_SERVICE_TOKEN must contain at least 32 characters');
  return createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError(401, 'UNAUTHORIZED', 'Release bearer token required');
      if (req.method === 'POST' && path === '/releases') {
        const value = await body(req);
        if (!value || !Object.hasOwn(repositories, value.repository)) throw new AppError(403, 'REPOSITORY_NOT_ALLOWED', 'Release repository is not allowlisted');
        const release = store.submit(req.headers['idempotency-key'], value); return send(202, { id: release.id });
      }
      const match = path.match(/^\/releases\/([a-f0-9-]{36})(\/evidence)?$/);
      if (!match || req.method !== 'GET') throw new AppError(404, 'NOT_FOUND', 'Route not found');
      const release = store.get(match[1]);
      if (match[2]) return send(200, { id: release.id, repository: release.repository, sourceCommitSha: release.request.sourceSha, sourceTreeSha: release.tree_sha, status: release.status, error: release.error_code, ...release.checkpoint });
      return send(200, { id: release.id, status: release.status, ...(release.result ? { result: release.result } : {}), ...(release.error_code ? { error: release.error_code, retryable: false } : {}) });
    } catch (error) { send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : 'Internal release error' }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.RELEASE_REPOSITORIES_FILE || !process.env.RELEASE_PUBLIC_URL) throw new Error('Configure RELEASE_REPOSITORIES_FILE and RELEASE_PUBLIC_URL');
  const repositories = JSON.parse(readFileSync(process.env.RELEASE_REPOSITORIES_FILE, 'utf8'));
  const databasePath = process.env.RELEASE_DATABASE_PATH ?? './release-data/releases.sqlite';
  const unlock = acquireRuntimeLock(databasePath); let memory, server;
  try {
    memory = new Memory(databasePath); const store = new ReleaseStore(memory);
    const api = new GitHubApi({ token: process.env.GITHUB_RELEASE_TOKEN });
    const engine = new ReleaseEngine({ store, repositories, api, publicUrl: process.env.RELEASE_PUBLIC_URL });
    server = createReleaseApp({ store, repositories, token: process.env.RELEASE_SERVICE_TOKEN });
    const port = Number(process.env.RELEASE_PORT ?? 3200); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELEASE_PORT must be 1–65535');
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, process.env.RELEASE_HOST ?? '127.0.0.1', () => { server.removeListener('error', reject); console.log(`Release service listening on port ${port}`); done(); }); });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; server.close(); });
    while (!stopping) { if (!await engine.tick()) await new Promise(done => setTimeout(done, 1000)); }
  } finally { if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } memory?.close(); unlock(); }
}
