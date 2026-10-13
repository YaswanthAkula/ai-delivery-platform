import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireText, validateSpec } from './memory.mjs';

export function validateOperation(value) {
  if (!value || typeof value !== 'object') throw new AppError(400, 'INVALID_OPERATION', 'Operation body required');
  for (const key of ['runId', 'jobId']) if (typeof value[key] !== 'string' || !/^[a-f0-9-]{36}$/.test(value[key])) throw new AppError(400, 'INVALID_OPERATION', `${key} must be a UUID`);
  if (!['design', 'implementation', 'review', 'qa', 'release'].includes(value.kind)) throw new AppError(400, 'INVALID_OPERATION', 'Unsupported operation kind');
  if (!Number.isInteger(value.specificationVersion) || value.specificationVersion < 1) throw new AppError(400, 'INVALID_OPERATION', 'Specification version required');
  if (typeof value.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) throw new AppError(400, 'INVALID_OPERATION', 'Repository must use owner/name format');
  const specification = validateSpec(value.payload?.specification);
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 50) throw new AppError(400, 'INVALID_OPERATION', 'Dependencies array required');
  return { runId: value.runId, jobId: value.jobId, repository: value.repository, specificationVersion: value.specificationVersion, kind: value.kind,
    payload: { ...value.payload, specification }, dependencies: value.dependencies };
}
export class OperationStore {
  constructor(memory) {
    this.memory = memory; this.db = memory.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_runs (id TEXT PRIMARY KEY, repository TEXT NOT NULL, spec_hash TEXT NOT NULL, workspace TEXT, base_sha TEXT);
      CREATE TABLE IF NOT EXISTS runtime_operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, request TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runtime_runs(id), status TEXT NOT NULL DEFAULT 'queued', result TEXT, error_code TEXT, artifact TEXT,
      created_at TEXT NOT NULL);`);
  }
  submit(requestKey, value) {
    requireText(requestKey, 'Idempotency-Key', 200);
    const request = validateOperation(value); const serialized = JSON.stringify(request);
    const hash = createHash('sha256').update(serialized).digest('hex');
    const specHash = createHash('sha256').update(JSON.stringify({ version: request.specificationVersion, specification: request.payload.specification })).digest('hex');
    return this.memory.transaction(() => {
      const existing = this.db.prepare('SELECT id,request_hash FROM runtime_operations WHERE request_key=?').get(requestKey);
      if (existing) { if (existing.request_hash !== hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Request key already belongs to a different payload'); return this.get(existing.id); }
      const run = this.db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(request.runId);
      if (run && (run.repository !== request.repository || run.spec_hash !== specHash)) throw new AppError(409, 'RUN_CONFLICT', 'Run repository and approved specification are immutable');
      if (!run) this.db.prepare('INSERT INTO runtime_runs (id,repository,spec_hash) VALUES (?,?,?)').run(request.runId, request.repository, specHash);
      const id = randomUUID();
      this.db.prepare('INSERT INTO runtime_operations (id,request_key,request_hash,request,run_id,created_at) VALUES (?,?,?,?,?,?)').run(id, requestKey, hash, serialized, request.runId, new Date().toISOString());
      return this.get(id);
    });
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM runtime_operations WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'OPERATION_NOT_FOUND', 'Operation not found');
    return { ...row, request: JSON.parse(row.request), result: row.result ? JSON.parse(row.result) : null };
  }
  claim() {
    return this.memory.transaction(() => {
      // Initial runtime serializes all execution. Scale through isolated services later.
      if (this.db.prepare("SELECT 1 FROM runtime_operations WHERE status='running'").get()) return null;
      const row = this.db.prepare("SELECT id FROM runtime_operations WHERE status='queued' ORDER BY rowid LIMIT 1").get();
      if (!row) return null;
      this.db.prepare("UPDATE runtime_operations SET status='running' WHERE id=?").run(row.id); return this.get(row.id);
    });
  }
  workspace(runId) { return this.db.prepare('SELECT * FROM runtime_runs WHERE id=?').get(runId); }
  saveWorkspace(runId, path, baseSha) { this.db.prepare('UPDATE runtime_runs SET workspace=?,base_sha=? WHERE id=?').run(path, baseSha, runId); }
  complete(id, result, artifact) {
    this.db.prepare("UPDATE runtime_operations SET status='succeeded',result=?,artifact=? WHERE id=? AND status='running'").run(JSON.stringify(result), JSON.stringify(artifact), id);
  }
  fail(id, code, artifact) {
    this.db.prepare("UPDATE runtime_operations SET status='failed',error_code=?,artifact=? WHERE id=? AND status='running'").run(code, artifact ? JSON.stringify(artifact) : null, id);
  }
  recoverInterrupted() {
    // External effects may already have occurred. Never replay uncertain deployment/coding.
    this.db.prepare("UPDATE runtime_operations SET status='failed',error_code='EXECUTION_INTERRUPTED' WHERE status='running'").run();
  }
}
