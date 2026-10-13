import { randomUUID } from 'node:crypto';
import { AppError, requireText } from './memory.mjs';
import { validateEvidence } from './runtime.mjs';

export function validateTasks(tasks, criteriaCount) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 40) throw new AppError(502, 'INVALID_TASK_PLAN', 'Manager must produce 1–40 implementation tasks');
  const seen = new Set(); const covered = new Set();
  const result = tasks.map(task => {
    if (!task || task.key === 'manager' || !/^[a-z][a-z0-9_-]{0,63}$/.test(task.key) || seen.has(task.key)) throw new AppError(502, 'INVALID_TASK_PLAN', 'Task keys must be unique, non-reserved identifiers');
    if (!Array.isArray(task.dependencies) || task.dependencies.some(key => !seen.has(key))) throw new AppError(502, 'INVALID_TASK_PLAN', 'Dependencies must refer to earlier tasks');
    if (!Array.isArray(task.criteria) || !task.criteria.length || task.criteria.some(index => !Number.isInteger(index) || index < 0 || index >= criteriaCount)) throw new AppError(502, 'INVALID_TASK_PLAN', 'Each task must map to valid acceptance-criterion indexes');
    for (const index of task.criteria) covered.add(index);
    seen.add(task.key);
    return { key: task.key, title: requireText(task.title, 'task title', 200), instructions: requireText(task.instructions, 'task instructions'), dependencies: [...new Set(task.dependencies)], criteria: [...new Set(task.criteria)] };
  });
  if (covered.size !== criteriaCount) throw new AppError(502, 'INVALID_TASK_PLAN', 'Every acceptance criterion must be covered');
  return result;
}

export class DeliveryStore {
  constructor(memory) {
    this.memory = memory; this.db = memory.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), specification_version INTEGER NOT NULL,
      repository TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', max_attempts INTEGER NOT NULL,
      max_dispatches INTEGER NOT NULL, dispatches INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      UNIQUE(project_id,specification_version));
      CREATE TABLE IF NOT EXISTS delivery_jobs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES delivery_runs(id), task_key TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, dependencies TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER, available_at INTEGER NOT NULL DEFAULT 0,
      checkpoint TEXT, result TEXT, error_code TEXT, UNIQUE(run_id,task_key));`);
  }
  start(projectId, { repository, maxAttempts = 3, maxDispatches = 100 }) {
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new AppError(400, 'INVALID_REPOSITORY', 'Use owner/repository format');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 || !Number.isInteger(maxDispatches) || maxDispatches < 1 || maxDispatches > 1000) throw new AppError(400, 'INVALID_LIMIT', 'maxAttempts must be 1–10 and maxDispatches 1–1000');
    return this.memory.transaction(() => {
      const project = this.memory.project(projectId); const specification = this.memory.specs(projectId).find(row => row.approved_at);
      if (!specification || !['ready', 'building', 'reviewing', 'testing', 'deploying', 'delivered'].includes(project.stage)) throw new AppError(409, 'PLAN_NOT_APPROVED', 'Approve a specification before starting delivery');
      const existing = this.db.prepare('SELECT id,repository FROM delivery_runs WHERE project_id=? AND specification_version=?').get(projectId, specification.version);
      if (existing) {
        if (existing.repository !== repository) throw new AppError(409, 'REPOSITORY_FROZEN', 'This specification already has a delivery target');
        return this.run(existing.id);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO delivery_runs (id,project_id,specification_version,repository,max_attempts,max_dispatches,created_at) VALUES (?,?,?,?,?,?,?)').run(id, projectId, specification.version, repository, maxAttempts, maxDispatches, new Date().toISOString());
      this.insertJob(id, 'manager', 'manager', { specification: specification.content }, []);
      return this.run(id);
    });
  }
  insertJob(runId, key, kind, payload, dependencies) {
    this.db.prepare('INSERT INTO delivery_jobs (id,run_id,task_key,kind,payload,dependencies) VALUES (?,?,?,?,?,?)').run(randomUUID(), runId, key, kind, JSON.stringify(payload), JSON.stringify(dependencies));
  }
  run(id) {
    const row = this.db.prepare('SELECT * FROM delivery_runs WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'RUN_NOT_FOUND', 'Delivery run not found');
    return { ...row, jobs: this.db.prepare('SELECT * FROM delivery_jobs WHERE run_id=? ORDER BY rowid').all(id).map(job => ({ ...job, payload: JSON.parse(job.payload), dependencies: JSON.parse(job.dependencies), checkpoint: job.checkpoint ? JSON.parse(job.checkpoint) : null, result: job.result ? JSON.parse(job.result) : null })) };
  }
  forProject(id) { this.memory.project(id); return this.db.prepare('SELECT id FROM delivery_runs WHERE project_id=? ORDER BY created_at').all(id).map(row => this.run(row.id)); }
  claim(now = Date.now(), leaseMs = 90000) {
    return this.memory.transaction(() => {
      this.db.prepare("UPDATE delivery_jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const runs = this.db.prepare("SELECT id FROM delivery_runs WHERE status IN ('queued','running') ORDER BY created_at,id").all();
      for (const { id } of runs) {
        const run = this.run(id);
        if (run.jobs.some(job => job.status === 'running')) continue; // one active job per run; integration ownership stays serial
        const candidate = run.jobs.find(job => job.status === 'queued' && job.available_at <= now && job.dependencies.every(key => run.jobs.some(other => other.task_key === key && other.status === 'succeeded')));
        if (!candidate) continue;
        // Polling a persisted remote operation does not consume a new dispatch attempt.
        if (!candidate.checkpoint && (candidate.attempts >= run.max_attempts || run.dispatches >= run.max_dispatches)) {
          this.db.prepare("UPDATE delivery_jobs SET status='blocked',error_code='EXECUTION_LIMIT' WHERE id=?").run(candidate.id);
          this.db.prepare("UPDATE delivery_runs SET status='blocked' WHERE id=?").run(id); continue;
        }
        const token = randomUUID(); const increment = candidate.checkpoint ? 0 : 1;
        this.db.prepare("UPDATE delivery_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+? WHERE id=?").run(token, now + leaseMs, increment, candidate.id);
        this.db.prepare("UPDATE delivery_runs SET status='running',dispatches=dispatches+? WHERE id=?").run(increment, id);
        const stages = { manager: 'ready', design: 'building', implementation: 'building', review: 'reviewing', qa: 'testing', release: 'deploying' };
        this.db.prepare('UPDATE projects SET stage=? WHERE id=?').run(stages[candidate.kind], run.project_id);
        return { run: this.run(id), job: this.run(id).jobs.find(job => job.id === candidate.id), token };
      }
      return null;
    });
  }
  owned(jobId, token) {
    const row = this.db.prepare("SELECT * FROM delivery_jobs WHERE id=? AND lease_token=? AND status='running'").get(jobId, token);
    if (!row || row.lease_until <= Date.now()) throw new AppError(409, 'LEASE_LOST', 'Worker no longer owns this job');
    return row;
  }
  heartbeat(jobId, token, leaseMs = 90000) { this.owned(jobId, token); this.db.prepare('UPDATE delivery_jobs SET lease_until=? WHERE id=? AND lease_token=?').run(Date.now() + leaseMs, jobId, token); }
  checkpoint(jobId, token, checkpoint) { this.owned(jobId, token); this.db.prepare('UPDATE delivery_jobs SET checkpoint=? WHERE id=? AND lease_token=?').run(JSON.stringify(checkpoint), jobId, token); }
  defer(jobId, token, delayMs = 2000) {
    this.owned(jobId, token);
    this.db.prepare("UPDATE delivery_jobs SET status='queued',available_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(Date.now() + delayMs, jobId, token);
  }
  finish(jobId, token, result) {
    return this.memory.transaction(() => {
      const job = this.owned(jobId, token); const run = this.run(job.run_id);
      if (job.kind !== 'manager') validateEvidence(job.kind, result, JSON.parse(job.payload).specification.acceptanceCriteria.length);
      if (job.kind === 'manager') {
        const specification = JSON.parse(job.payload).specification;
        const tasks = validateTasks(result.tasks, specification.acceptanceCriteria.length);
        const designKey = '__design';
        this.insertJob(run.id, designKey, 'design', { specification, instructions: 'Create screen flows, design system and interaction states for the approved scope.' }, ['manager']);
        for (const task of tasks) this.insertJob(run.id, task.key, 'implementation', { ...task, specification }, [designKey, ...task.dependencies]);
        this.insertJob(run.id, '__review', 'review', { specification }, tasks.map(task => task.key));
        this.insertJob(run.id, '__qa', 'qa', { specification }, ['__review']);
        this.insertJob(run.id, '__release', 'release', { specification }, ['__qa']);
      }
      this.db.prepare("UPDATE delivery_jobs SET status='succeeded',result=?,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=?").run(JSON.stringify(result), jobId);
      const stages = { manager: 'building', design: 'building', implementation: 'building', review: 'testing', qa: 'deploying', release: 'delivered' };
      this.db.prepare('UPDATE projects SET stage=? WHERE id=?').run(stages[job.kind], run.project_id);
      if (job.kind === 'release') this.db.prepare("UPDATE delivery_runs SET status='delivered' WHERE id=?").run(run.id);
    });
  }
  fail(jobId, token, code, { retryable = false, clearCheckpoint = false } = {}) {
    return this.memory.transaction(() => {
      const job = this.owned(jobId, token); const run = this.run(job.run_id);
      const retry = retryable && job.attempts < run.max_attempts && run.dispatches < run.max_dispatches;
      this.db.prepare('UPDATE delivery_jobs SET status=?,error_code=?,checkpoint=?,lease_token=NULL,lease_until=NULL,available_at=? WHERE id=?').run(retry ? 'queued' : 'blocked', code, clearCheckpoint ? null : job.checkpoint, Date.now() + Math.min(30000, 1000 * 2 ** job.attempts), jobId);
      if (!retry) this.db.prepare("UPDATE delivery_runs SET status='blocked' WHERE id=?").run(run.id);
    });
  }
  resume(projectId, runId) {
    return this.memory.transaction(() => {
      const run = this.run(runId);
      if (run.project_id !== projectId) throw new AppError(404, 'RUN_NOT_FOUND', 'Delivery run not found');
      if (run.status !== 'blocked') throw new AppError(409, 'NOT_BLOCKED', 'Only blocked runs can be resumed');
      if (run.jobs.some(job => job.error_code === 'OPERATION_TIMEOUT')) throw new AppError(409, 'RECONCILIATION_REQUIRED', 'Reconcile timed-out remote operations before resuming');
      if (run.dispatches >= run.max_dispatches) throw new AppError(409, 'EXECUTION_LIMIT', 'Run dispatch budget is exhausted');
      if (run.jobs.some(job => job.status === 'blocked' && job.attempts >= run.max_attempts && !job.checkpoint)) throw new AppError(409, 'EXECUTION_LIMIT', 'Job retry limit is exhausted');
      this.db.prepare("UPDATE delivery_jobs SET status='queued',available_at=0,error_code=NULL WHERE run_id=? AND status='blocked'").run(runId);
      this.db.prepare("UPDATE delivery_runs SET status='queued' WHERE id=?").run(runId);
      return this.run(runId);
    });
  }
}
