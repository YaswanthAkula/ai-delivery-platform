import { randomUUID, createHash } from 'node:crypto';
import { AppError, requireText } from './memory.mjs';
import { validateSnapshot } from './github-release.mjs';

export class ReleaseStore {
  constructor(memory) {
    this.memory = memory; this.db = memory.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS release_operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
      repository TEXT NOT NULL, run_id TEXT NOT NULL, tree_sha TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      checkpoint TEXT NOT NULL DEFAULT '{}', result TEXT, error_code TEXT, failures INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(repository,run_id));`);
  }
  submit(key, value) {
    requireText(key, 'Idempotency-Key', 200); const request = validateSnapshot(value);
    const serialized = JSON.stringify(request); const hash = createHash('sha256').update(serialized).digest('hex');
    return this.memory.transaction(() => {
      const existing = this.db.prepare('SELECT id,request_hash FROM release_operations WHERE request_key=? OR (repository=? AND run_id=?)').get(key, request.repository, request.runId);
      if (existing) { if (existing.request_hash !== hash) throw new AppError(409, 'RELEASE_CONFLICT', 'Release key/run already belongs to another snapshot'); return this.get(existing.id); }
      const id = randomUUID();
      this.db.prepare('INSERT INTO release_operations (id,request_key,request_hash,repository,run_id,tree_sha,request,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, key, hash, request.repository, request.runId, request.treeSha, serialized, new Date().toISOString());
      return this.get(id);
    });
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM release_operations WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'RELEASE_NOT_FOUND', 'Release not found');
    return { ...row, request: JSON.parse(row.request), checkpoint: JSON.parse(row.checkpoint), result: row.result ? JSON.parse(row.result) : null };
  }
  next() {
    const row = this.db.prepare("SELECT id FROM release_operations WHERE status IN ('queued','running') AND available_at<=? ORDER BY available_at,rowid LIMIT 1").get(Date.now());
    return row ? this.get(row.id) : null;
  }
  save(id, checkpoint, delayMs = 2000) { this.db.prepare("UPDATE release_operations SET status='running',checkpoint=?,available_at=? WHERE id=?").run(JSON.stringify(checkpoint), Date.now() + delayMs, id); }
  complete(id, result, checkpoint) { this.db.prepare("UPDATE release_operations SET status='succeeded',result=?,checkpoint=? WHERE id=?").run(JSON.stringify(result), JSON.stringify(checkpoint), id); }
  fail(id, code) { this.db.prepare("UPDATE release_operations SET status='failed',error_code=? WHERE id=?").run(code, id); }
  transientFailure(id, limit = 3) {
    const row = this.get(id);
    this.db.prepare('UPDATE release_operations SET failures=failures+1,available_at=? WHERE id=?').run(Date.now() + 5000, id);
    if (row.failures + 1 >= limit) this.fail(id, 'RELEASE_PROVIDER_UNAVAILABLE');
  }
}
