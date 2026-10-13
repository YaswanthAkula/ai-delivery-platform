import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function requireText(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new AppError(400, 'INVALID_INPUT', `${name} must be non-empty text (max ${max} characters)`);
  return value.trim();
}
export function validateSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_SPEC', 'Specification must be an object');
  const result = { title: requireText(value.title, 'title', 200), goal: requireText(value.goal, 'goal') };
  for (const key of ['users', 'inScope', 'outOfScope', 'acceptanceCriteria', 'assumptions', 'openQuestions']) {
    if (!Array.isArray(value[key]) || value[key].length > 100) throw new AppError(400, 'INVALID_SPEC', `${key} must be an array (max 100 items)`);
    result[key] = value[key].map(item => requireText(item, key, 2000));
  }
  for (const key of ['users', 'inScope', 'acceptanceCriteria']) {
    if (!result[key].length) throw new AppError(400, 'INVALID_SPEC', `${key} cannot be empty`);
  }
  return result;
}

export class Memory {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, idea TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'planning', revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specifications (project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL, content TEXT NOT NULL, basis_revision INTEGER NOT NULL, approved_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY(project_id,version));
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(name, idea) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO projects (id,name,idea,created_at) VALUES (?,?,?,?)').run(id, requireText(name, 'name', 200), requireText(idea, 'idea'), new Date().toISOString());
    return this.project(id);
  }
  list() { return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC,id').all(); }
  project(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    return row;
  }
  history(id) { this.project(id); return this.db.prepare('SELECT role,content,created_at FROM messages WHERE project_id=? ORDER BY id').all(id); }
  specs(id) {
    this.project(id);
    return this.db.prepare('SELECT * FROM specifications WHERE project_id=? ORDER BY version').all(id).map(row => ({ ...row, content: JSON.parse(row.content) }));
  }
  tokens(id) {
    this.project(id);
    return this.db.prepare('SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens FROM usage WHERE project_id=?').get(id);
  }
  usage(id, model, counts) {
    this.db.prepare('INSERT INTO usage (project_id,model,input_tokens,output_tokens,created_at) VALUES (?,?,?,?,?)').run(id, model, counts.input_tokens ?? 0, counts.output_tokens ?? 0, new Date().toISOString());
  }
  commitTurn(id, revision, input, reply, specification) {
    return this.transaction(() => {
      const project = this.project(id);
      if (project.revision !== revision || project.stage !== 'planning') throw new AppError(409, 'STALE_PLAN', 'Project changed while the planner was running');
      const timestamp = new Date().toISOString();
      const insert = this.db.prepare('INSERT INTO messages (project_id,role,content,created_at) VALUES (?,?,?,?)');
      insert.run(id, 'user', input, timestamp); insert.run(id, 'assistant', reply, timestamp);
      let version = null;
      if (specification) {
        version = (this.db.prepare('SELECT MAX(version) latest FROM specifications WHERE project_id=?').get(id).latest ?? 0) + 1;
        this.db.prepare('INSERT INTO specifications (project_id,version,content,basis_revision,created_at) VALUES (?,?,?,?,?)').run(id, version, JSON.stringify(specification), revision + 1, timestamp);
      }
      this.db.prepare('UPDATE projects SET revision=revision+1 WHERE id=?').run(id);
      return { project: this.project(id), reply, specificationVersion: version };
    });
  }
  saveSpec(id, content) {
    const spec = validateSpec(content);
    return this.transaction(() => {
      const project = this.project(id);
      if (project.stage !== 'planning') throw new AppError(409, 'PLAN_FROZEN', 'Approved plans are immutable; revisions require a future change-request flow');
      const version = (this.db.prepare('SELECT MAX(version) latest FROM specifications WHERE project_id=?').get(id).latest ?? 0) + 1;
      this.db.prepare('INSERT INTO specifications (project_id,version,content,basis_revision,created_at) VALUES (?,?,?,?,?)').run(id, version, JSON.stringify(spec), project.revision + 1, new Date().toISOString());
      this.db.prepare('UPDATE projects SET revision=revision+1 WHERE id=?').run(id);
      return { version, content: spec };
    });
  }
  approve(id, version, revision, acknowledged) {
    if (!Number.isInteger(version) || version < 1 || !Number.isInteger(revision) || revision < 0) throw new AppError(400, 'INVALID_INPUT', 'version and expectedRevision must be non-negative integers; version starts at 1');
    return this.transaction(() => {
      const project = this.project(id);
      if (project.stage !== 'planning' || project.revision !== revision) throw new AppError(409, 'STALE_PLAN', 'Approval must match the current project revision');
      const specs = this.specs(id); const latest = specs.at(-1);
      if (!latest || latest.version !== version) throw new AppError(409, 'STALE_SPEC', 'Approve the latest specification version');
      if (latest.basis_revision !== project.revision) throw new AppError(409, 'STALE_SPEC', 'Conversation changed after this draft; regenerate or save an updated specification');
      if (latest.content.openQuestions.length) throw new AppError(409, 'OPEN_QUESTIONS', 'Resolve open questions before approval');
      if (latest.content.assumptions.length && acknowledged !== true) throw new AppError(409, 'ASSUMPTIONS_UNCONFIRMED', 'Explicitly acknowledge the specification assumptions');
      this.db.prepare('UPDATE specifications SET approved_at=? WHERE project_id=? AND version=?').run(new Date().toISOString(), id, version);
      this.db.prepare("UPDATE projects SET stage='ready',revision=revision+1 WHERE id=?").run(id);
      return this.project(id);
    });
  }
}
