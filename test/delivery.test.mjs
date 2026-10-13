import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';
import { DeliveryStore, validateTasks } from '../src/delivery-store.mjs';
import { DeliveryWorker } from '../src/worker.mjs';
import { createManager } from '../src/manager.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createApp } from '../src/server.mjs';

const specification = { title: 'App', goal: 'Book appointments', users: ['Receptionist'], inScope: ['Booking'], outOfScope: ['Billing'], acceptanceCriteria: ['Booking returns ID'], assumptions: [], openQuestions: [] };
const tasks = [{ key: 'booking', title: 'Booking workflow', instructions: 'Implement approved booking workflow', dependencies: [], criteria: [0] }];
const manager = { model: 'test-manager', async decompose() { return { tasks, usage: { input_tokens: 10, output_tokens: 5 } }; } };
function setup(t, limits = {}) {
  const memory = new Memory(':memory:'); t.after(() => memory.close());
  const store = new DeliveryStore(memory); const project = memory.create('App', 'Idea');
  memory.saveSpec(project.id, specification); memory.approve(project.id, 1, 1, false);
  const run = store.start(project.id, { repository: 'owner/app', ...limits });
  return { memory, store, project, run };
}
function evidence(kind) {
  const base = { evidenceUrl: 'https://runtime.example/evidence' };
  if (kind === 'design') return { ...base, designUrl: 'https://runtime.example/design' };
  if (kind === 'implementation') return { ...base, commitSha: 'a'.repeat(40), diffUrl: 'https://runtime.example/diff' };
  if (kind === 'review') return { ...base, reviewPassed: true };
  if (kind === 'qa') return { ...base, acceptanceResults: [{ index: 0, passed: true, evidenceUrl: base.evidenceUrl }] };
  return { ...base, deployedUrl: 'https://app.example', smokePassed: true, smokeEvidenceUrl: base.evidenceUrl };
}
function runtimeSuccess() {
  const operations = new Map(); let count = 0;
  return {
    get count() { return count; },
    async start(payload, key) { if (!operations.has(key)) { count++; operations.set(key, payload.kind); } return key; },
    async poll(key) { return { status: 'succeeded', result: evidence(operations.get(key)) }; }
  };
}
test('delivery needs an approved plan and start is idempotent', t => {
  const { store, project, memory, run } = setup(t);
  assert.equal(store.start(project.id, { repository: 'owner/app' }).id, run.id);
  assert.throws(() => store.start(project.id, { repository: 'owner/other' }), error => error.code === 'REPOSITORY_FROZEN');
  const unapproved = memory.create('New', 'Idea');
  assert.throws(() => store.start(unapproved.id, { repository: 'owner/app' }), error => error.code === 'PLAN_NOT_APPROVED');
});
test('task validation rejects missing criterion coverage, cycles, duplicates and reserved keys', () => {
  assert.throws(() => validateTasks(tasks, 2));
  assert.throws(() => validateTasks([{ ...tasks[0], dependencies: ['booking'] }], 1));
  assert.throws(() => validateTasks([...tasks, tasks[0]], 1));
  assert.throws(() => validateTasks([{ ...tasks[0], key: 'manager' }], 1));
});
test('manager adds mandatory design, implementation, review, QA and release gates', async t => {
  const { store, run, memory, project } = setup(t);
  const worker = new DeliveryWorker({ store, manager, runtime: runtimeSuccess(), pollDelayMs: 0 });
  assert.equal(await worker.tick(), true);
  const jobs = store.run(run.id).jobs;
  assert.deepEqual(jobs.map(job => job.kind), ['manager', 'design', 'implementation', 'review', 'qa', 'release']);
  assert.deepEqual(jobs.find(job => job.kind === 'release').dependencies, ['__qa']);
  assert.equal(memory.project(project.id).stage, 'building');
  assert.deepEqual({ ...memory.tokens(project.id) }, { input_tokens: 10, output_tokens: 5 });
});
test('full scheduler proceeds to delivered only with tool-shaped evidence', async t => {
  const { store, run, memory, project } = setup(t);
  const runtime = runtimeSuccess(); const worker = new DeliveryWorker({ store, manager, runtime, pollDelayMs: 0 });
  for (let i = 0; i < 6; i++) assert.equal(await worker.tick(), true);
  assert.equal(await worker.tick(), false);
  assert.equal(store.run(run.id).status, 'delivered'); assert.equal(memory.project(project.id).stage, 'delivered');
  assert.equal(runtime.count, 5); assert.ok(store.run(run.id).jobs.every(job => job.status === 'succeeded'));
});
test('failed review blocks dependent QA and release instead of accepting agent claims', async t => {
  const { store, run } = setup(t);
  const runtime = runtimeSuccess(); const original = runtime.poll;
  runtime.poll = async key => { const operation = await original(key); if (operation.result.reviewPassed) operation.result.reviewPassed = false; return operation; };
  const worker = new DeliveryWorker({ store, manager, runtime, pollDelayMs: 0 });
  for (let i = 0; i < 4; i++) await worker.tick();
  const saved = store.run(run.id);
  assert.equal(saved.status, 'blocked'); assert.equal(saved.jobs.find(job => job.kind === 'review').error_code, 'REVIEW_FAILED');
  assert.equal(saved.jobs.find(job => job.kind === 'qa').status, 'queued'); assert.equal(await worker.tick(), false);
});
test('unconfigured manager blocks visibly without fake tasks', async t => {
  const { store, run } = setup(t);
  await new DeliveryWorker({ store, manager: createManager({}), runtime: createRuntime({}) }).tick();
  const saved = store.run(run.id);
  assert.equal(saved.status, 'blocked'); assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].error_code, 'MANAGER_NOT_CONFIGURED');
});
test('lease reclaim rejects stale workers and runs one active task per project', t => {
  const { store, run } = setup(t);
  const first = store.claim(); assert.ok(first); assert.equal(store.claim(), null);
  store.db.prepare('UPDATE delivery_jobs SET lease_until=0 WHERE id=?').run(first.job.id);
  const second = store.claim(); assert.ok(second); assert.notEqual(second.token, first.token);
  assert.throws(() => store.finish(first.job.id, first.token, { tasks }), error => error.code === 'LEASE_LOST');
  store.finish(second.job.id, second.token, { tasks });
  assert.equal(store.run(run.id).jobs[0].status, 'succeeded');
});
test('execution dispatch cap blocks without starting additional tasks', async t => {
  const { store, run } = setup(t, { maxDispatches: 1 });
  const runtime = runtimeSuccess(); const worker = new DeliveryWorker({ store, manager, runtime });
  await worker.tick(); assert.equal(await worker.tick(), false);
  assert.equal(store.run(run.id).status, 'blocked'); assert.equal(runtime.count, 0);
});
test('restart polls persisted runtime operation without duplicate submission or dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-recovery-')); const path = join(directory, 'platform.sqlite');
  let memory = new Memory(path);
  try {
    let store = new DeliveryStore(memory); const project = memory.create('App', 'Idea');
    memory.saveSpec(project.id, specification); memory.approve(project.id, 1, 1, false);
    const run = store.start(project.id, { repository: 'owner/app' });
    let managerClaim = store.claim(); store.finish(managerClaim.job.id, managerClaim.token, { tasks });
    const claim = store.claim();
    store.checkpoint(claim.job.id, claim.token, { requestKey: 'persisted-key', operationId: 'operation_1', startedAt: Date.now(), pollFailures: 0 });
    store.db.prepare('UPDATE delivery_jobs SET lease_until=0 WHERE id=?').run(claim.job.id);
    memory.close(); memory = new Memory(path); store = new DeliveryStore(memory);
    const worker = new DeliveryWorker({ store, manager, runtime: { async start() { throw new Error('must not submit twice'); }, async poll(id) { assert.equal(id, 'operation_1'); return { status: 'succeeded', result: evidence('design') }; } } });
    await worker.tick();
    const saved = store.run(run.id);
    assert.equal(saved.dispatches, 2); assert.equal(saved.jobs[1].attempts, 1); assert.equal(saved.jobs[1].status, 'succeeded');
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('ambiguous submission retries with the same persisted idempotency key', async t => {
  const { store, run } = setup(t); const keys = []; let calls = 0;
  const runtime = { async start(payload, key) { keys.push(key); if (++calls === 1) { const error = new Error(); error.retryable = true; error.code = 'RUNTIME_UNAVAILABLE'; throw error; } return 'op_1'; }, async poll() { return { status: 'succeeded', result: evidence('design') }; } };
  const worker = new DeliveryWorker({ store, manager, runtime, pollDelayMs: 0 });
  await worker.tick(); await worker.tick(); await worker.tick();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(store.run(run.id).jobs[1].attempts, 1); assert.equal(store.run(run.id).dispatches, 2);
});
test('runtime operation polling failures are bounded and timeout requires reconciliation', async t => {
  const { store, run, project } = setup(t, { maxAttempts: 2 });
  const runtime = { async start() { return 'op'; }, async poll() { const error = new Error(); error.retryable = true; error.code = 'RUNTIME_UNAVAILABLE'; throw error; } };
  const worker = new DeliveryWorker({ store, manager, runtime, pollDelayMs: 0 });
  await worker.tick(); await worker.tick(); await worker.tick();
  assert.equal(store.run(run.id).status, 'blocked');
  store.resume(project.id, run.id);
  const claim = store.claim(); store.fail(claim.job.id, claim.token, 'OPERATION_TIMEOUT');
  assert.throws(() => store.resume(project.id, run.id), error => error.code === 'RECONCILIATION_REQUIRED');
});
test('runtime HTTP adapter preserves auth/idempotency and rejects non-HTTPS endpoints', async () => {
  assert.throws(() => createRuntime({ url: 'http://runtime.example', token: 'secret' }));
  const runtime = createRuntime({ url: 'https://runtime.example/api', token: 'test-runtime-secret', fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://runtime.example/api/operations');
    assert.equal(options.headers['Idempotency-Key'], 'job:1'); assert.equal(options.headers.Authorization, 'Bearer test-runtime-secret');
    return Response.json({ id: 'op_1' });
  } });
  assert.equal(await runtime.start({ kind: 'design' }, 'job:1'), 'op_1');
});
test('manager adapter rejects uncovered task output and returns observed token usage', async () => {
  const make = value => createManager({ apiKey: 'secret', model: 'test', fetchImpl: async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 20, output_tokens: 10 } }) });
  assert.deepEqual((await make({ tasks }).decompose(specification)).usage, { input_tokens: 20, output_tokens: 10 });
  await assert.rejects(() => make({ tasks: [] }).decompose(specification), error => error.code === 'INVALID_TASK_PLAN' && error.usage.input_tokens === 20);
});
test('delivery API queues once and exposes authenticated persisted progress', async t => {
  const { memory, project, run, store } = setup(t);
  const token = 'local-delivery-test-token-123456789012345';
  const server = createApp({ memory, planner: {}, token, delivery: store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/projects/${project.id}/delivery`;
  assert.equal((await fetch(base)).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ repository: 'owner/app' }) });
  assert.equal(response.status, 202); assert.equal((await response.json()).id, run.id);
  assert.equal((await (await fetch(base, { headers })).json()).runs.length, 1);
});
