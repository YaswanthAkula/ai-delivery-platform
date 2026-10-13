import { pathToFileURL } from 'node:url';
import { Memory, AppError } from './memory.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { createManager } from './manager.mjs';
import { createRuntime, validateEvidence } from './runtime.mjs';

export class DeliveryWorker {
  constructor({ store, manager, runtime, pollDelayMs = 2000, operationTimeoutMs = 1800000 }) {
    this.store = store; this.manager = manager; this.runtime = runtime;
    this.pollDelayMs = pollDelayMs; this.operationTimeoutMs = operationTimeoutMs;
  }
  async tick() {
    const claim = this.store.claim(); if (!claim) return false;
    const { run, job, token } = claim;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try { this.store.heartbeat(job.id, token); } catch { leaseLost = true; }
    }, 20000);
    heartbeat.unref();
    try {
      if (job.kind === 'manager') {
        const result = await this.manager.decompose(job.payload.specification);
        this.store.memory.usage(run.project_id, this.manager.model, result.usage);
        if (leaseLost) throw new AppError(409, 'LEASE_LOST', 'Worker lease was lost');
        this.store.finish(job.id, token, { tasks: result.tasks });
      } else {
        let checkpoint = job.checkpoint;
        if (!checkpoint) {
          checkpoint = { requestKey: `${job.id}:${job.attempts}`, startedAt: Date.now(), pollFailures: 0 };
          this.store.checkpoint(job.id, token, checkpoint);
        }
        if (Date.now() - checkpoint.startedAt >= this.operationTimeoutMs) throw new AppError(409, 'OPERATION_TIMEOUT', 'Runtime operation exceeded its deadline; reconcile before resuming');
        if (!checkpoint.operationId) {
          const dependencies = run.jobs.filter(other => job.dependencies.includes(other.task_key)).map(other => ({ key: other.task_key, kind: other.kind, result: other.result }));
          const operationId = await this.runtime.start({ runId: run.id, jobId: job.id, repository: run.repository, specificationVersion: run.specification_version, kind: job.kind, payload: job.payload, dependencies }, checkpoint.requestKey);
          checkpoint = { ...checkpoint, operationId };
          this.store.checkpoint(job.id, token, checkpoint);
        }
        const operation = await this.runtime.poll(checkpoint.operationId);
        if (operation.status === 'queued' || operation.status === 'running') {
          this.store.checkpoint(job.id, token, { ...checkpoint, pollFailures: 0 });
          this.store.defer(job.id, token, this.pollDelayMs);
        } else if (operation.status === 'succeeded') {
          const result = validateEvidence(job.kind, operation.result, job.payload.specification.acceptanceCriteria.length);
          this.store.finish(job.id, token, result);
        } else if (operation.status === 'failed') {
          const code = typeof operation.error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(operation.error) ? operation.error : 'RUNTIME_TASK_FAILED';
          this.store.fail(job.id, token, code, { retryable: operation.retryable === true, clearCheckpoint: operation.retryable === true });
        } else throw new AppError(502, 'INVALID_RUNTIME_RESPONSE', 'Unknown runtime operation state');
      }
    } catch (error) {
      if (error.usage) this.store.memory.usage(run.project_id, this.manager.model, error.usage);
      try {
        if (error.retryable && job.kind !== 'manager') {
          const latest = this.store.run(run.id).jobs.find(item => item.id === job.id).checkpoint;
          const failures = (latest?.pollFailures ?? 0) + 1;
          if (latest && failures < run.max_attempts) {
            this.store.checkpoint(job.id, token, { ...latest, pollFailures: failures });
            this.store.defer(job.id, token, this.pollDelayMs * failures);
          } else this.store.fail(job.id, token, error.code ?? 'WORKER_FAILED');
        } else this.store.fail(job.id, token, error instanceof AppError ? error.code : 'WORKER_FAILED');
      } catch { /* A reclaimed job must not be changed by its old worker. */ }
    } finally { clearInterval(heartbeat); }
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const memory = new Memory(process.env.DATABASE_PATH ?? './data/platform.sqlite');
  const worker = new DeliveryWorker({ store: new DeliveryStore(memory), manager: createManager({ apiKey: process.env.OPENAI_API_KEY, model: process.env.MANAGER_MODEL }), runtime: createRuntime({ url: process.env.CODING_RUNTIME_URL, token: process.env.CODING_RUNTIME_TOKEN }) });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
  try {
    while (!stopping) {
      const processed = await worker.tick();
      if (!processed) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { memory.close(); }
}
