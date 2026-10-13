import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';
import { OperationStore } from '../src/operation-store.mjs';
import { createCodexRunner, CodexExecutor } from '../src/codex-executor.mjs';
import { createRuntimeApp, RuntimeWorker, acquireRuntimeLock } from '../src/runtime-server.mjs';
import { commandEnvironment, runCommand } from '../src/process.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { DeliveryWorker } from '../src/worker.mjs';
import { createRuntime } from '../src/runtime.mjs';

const spec = { title: 'Booking', goal: 'Book appointments', users: ['Receptionist'], inScope: ['Booking'], outOfScope: ['Billing'], acceptanceCriteria: ['A booking returns a confirmation ID'], assumptions: [], openQuestions: [] };
function request(kind = 'design', runId = randomUUID()) {
  return { runId, jobId: randomUUID(), repository: 'owner/app', specificationVersion: 1, kind, payload: { specification: spec, instructions: 'Implement the approved scope' }, dependencies: [] };
}
async function fixture(t, { codex, acceptanceChecks } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-execution-')); const source = join(root, 'source'); mkdirSync(source);
  const git = async (...args) => { const result = await runCommand(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: source }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  await git('init'); await git('config', 'user.name', 'Runtime Test'); await git('config', 'user.email', 'test@localhost');
  writeFileSync(join(source, 'README.md'), 'Initial application\n'); await git('add', '.'); await git('commit', '-m', 'Initial');
  const memory = new Memory(join(root, 'runtime.sqlite')); const store = new OperationStore(memory);
  const repositories = { 'owner/app': { path: source, ...(acceptanceChecks ? { acceptanceChecks } : {}) } };
  const executor = new CodexExecutor({ store, repositories, workspaceRoot: join(root, 'workspaces'), publicUrl: 'https://runtime.example', codex });
  const worker = new RuntimeWorker({ store, executor });
  t.after(() => { memory.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, source, memory, store, executor, worker, repositories, git };
}
test('runtime persists idempotent requests and rejects conflicting payload/run targets', t => {
  const memory = new Memory(':memory:'); t.after(() => memory.close()); const store = new OperationStore(memory);
  const value = request(); const operation = store.submit('job:1', value);
  assert.equal(store.submit('job:1', value).id, operation.id);
  assert.throws(() => store.submit('job:1', { ...value, kind: 'review' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => store.submit('job:2', { ...value, repository: 'owner/other' }), error => error.code === 'RUN_CONFLICT');
  assert.throws(() => store.submit('job:3', { ...value, runId: '../escape' }), error => error.code === 'INVALID_OPERATION');
});
test('interrupted operations never become falsely successful or replay automatically', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-restart-')); const path = join(root, 'runtime.sqlite');
  let memory = new Memory(path);
  try {
    let store = new OperationStore(memory); const operation = store.submit('job:1', request()); store.claim(); memory.close();
    memory = new Memory(path); store = new OperationStore(memory); store.recoverInterrupted();
    assert.equal(store.get(operation.id).status, 'failed'); assert.equal(store.get(operation.id).error_code, 'EXECUTION_INTERRUPTED');
    assert.equal(store.claim(), null); assert.equal(store.submit('job:1', operation.request).id, operation.id);
  } finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});
test('design and coding use an isolated real Git branch and preserve source repository', async t => {
  const codex = async ({ cwd, kind }) => {
    if (kind === 'design') { mkdirSync(join(cwd, '.delivery')); writeFileSync(join(cwd, '.delivery/design.md'), '# Booking screens\n'); }
    else writeFileSync(join(cwd, 'booking.mjs'), 'export const bookingId = "confirmed";\n');
    return { summary: 'Implemented', blocked: false, reviewPassed: false, usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const { worker, store, source, git } = await fixture(t, { codex }); const runId = randomUUID(); const before = await git('rev-parse', 'HEAD');
  const design = store.submit('design:1', request('design', runId)); await worker.tick();
  assert.equal(store.get(design.id).status, 'succeeded');
  const implementation = store.submit('implementation:1', request('implementation', runId)); await worker.tick();
  const completed = store.get(implementation.id);
  assert.equal(completed.status, 'succeeded'); assert.match(completed.result.commitSha, /^[a-f0-9]{40}$/);
  assert.match(JSON.parse(completed.artifact).diff, /bookingId/);
  assert.equal(await git('rev-parse', 'HEAD'), before); assert.equal(await git('status', '--porcelain'), '');
  assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), 'Initial application\n');
});
test('QA runs configured commands and records actual exit codes for each approved criterion', async t => {
  const { worker, store } = await fixture(t, { acceptanceChecks: [{ criterion: spec.acceptanceCriteria[0], argv: [process.execPath, '-e', 'console.log("acceptance verified")'] }] });
  const operation = store.submit('qa:1', request('qa')); await worker.tick();
  const completed = store.get(operation.id); assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.acceptanceResults[0].passed, true);
  assert.match(JSON.parse(completed.artifact).checks[0].stdout, /acceptance verified/);
});
test('failing acceptance command is recorded as a failure, never converted into a pass', async t => {
  const { worker, store } = await fixture(t, { acceptanceChecks: [{ criterion: spec.acceptanceCriteria[0], argv: [process.execPath, '-e', 'process.exit(2)'] }] });
  const operation = store.submit('qa:1', request('qa')); await worker.tick();
  assert.equal(store.get(operation.id).result.acceptanceResults[0].passed, false);
  assert.equal(JSON.parse(store.get(operation.id).artifact).checks[0].code, 2);
});
test('missing QA/deployment setup produces explicit blockers', async t => {
  const { worker, store } = await fixture(t);
  const runId = randomUUID();
  const qa = store.submit('qa:1', request('qa', runId)); await worker.tick();
  assert.equal(store.get(qa.id).error_code, 'ACCEPTANCE_CHECKS_MISSING');
  const release = store.submit('release:1', request('release', runId)); await worker.tick();
  assert.equal(store.get(release.id).error_code, 'RELEASE_ADAPTER_MISSING'); assert.equal(store.get(release.id).result, null);
});
test('read-only review cannot silently modify application code', async t => {
  const codex = async ({ cwd }) => { writeFileSync(join(cwd, 'README.md'), 'Unexpected change'); return { reviewPassed: true }; };
  const { worker, store } = await fixture(t, { codex });
  const operation = store.submit('review:1', request('review')); await worker.tick();
  assert.equal(store.get(operation.id).status, 'failed'); assert.equal(store.get(operation.id).error_code, 'REVIEW_MODIFIED_CODE');
});
test('Codex runner sends structured prompt through stdin with explicit sandbox and no backend secrets', async () => {
  const command = async (argv, options) => {
    assert.deepEqual(argv.slice(0, 6), ['codex', '--ask-for-approval', 'never', 'exec', '--json', '--sandbox']);
    assert.equal(argv[6], 'read-only'); assert.equal(argv.at(-1), '-'); assert.match(options.input, /Booking/);
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.CODING_RUNTIME_TOKEN, undefined);
    const output = argv[argv.indexOf('--output-last-message') + 1];
    writeFileSync(output, JSON.stringify({ summary: 'Reviewed', blocked: false, reviewPassed: true }));
    return { code: 0, stderr: '', stdout: '{"type":"thread.started","thread_id":"thread_1"}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n' };
  };
  const answer = await createCodexRunner({ command })({ cwd: '/tmp', kind: 'review', specification: spec, dependencies: [] });
  assert.equal(answer.threadId, 'thread_1'); assert.equal(answer.reviewPassed, true);
});
test('Codex missing executable and subprocess timeouts are explicit errors', async () => {
  await assert.rejects(() => createCodexRunner({ executable: '/does-not-exist/codex' })({ cwd: '/tmp', kind: 'review', specification: spec }), error => error.code === 'EXECUTABLE_UNAVAILABLE');
  await assert.rejects(() => runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }), error => error.code === 'COMMAND_TIMEOUT');
  assert.deepEqual(commandEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', APP_AUTH_TOKEN: 'secret', CODING_RUNTIME_TOKEN: 'secret' }), { PATH: '/bin' });
});
test('authenticated runtime API protects evidence and rejects repositories outside the allowlist', async t => {
  const { store, repositories, worker } = await fixture(t, { acceptanceChecks: [{ criterion: spec.acceptanceCriteria[0], argv: [process.execPath, '-e', 'process.exit(0)'] }] });
  const token = 'local-runtime-test-token-12345678901234567890';
  const server = createRuntimeApp({ store, repositories, token }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'qa:1' };
  assert.equal((await fetch(base + '/operations')).status, 401);
  assert.equal((await fetch(base + '/operations', { method: 'POST', headers, body: JSON.stringify({ ...request(), repository: 'unknown/app' }) })).status, 403);
  const value = request('qa');
  const submitted = await fetch(base + '/operations', { method: 'POST', headers, body: JSON.stringify(value) }); assert.equal(submitted.status, 202);
  const { id } = await submitted.json();
  assert.equal((await (await fetch(base + '/operations', { method: 'POST', headers, body: JSON.stringify(value) })).json()).id, id);
  await worker.tick();
  assert.equal((await (await fetch(base + `/operations/${id}`, { headers })).json()).status, 'succeeded');
  assert.equal((await fetch(base + `/operations/${id}/evidence`)).status, 401);
  assert.equal((await fetch(base + `/operations/${id}/evidence`, { headers })).status, 200);
});
test('runtime lock prevents a second service from recovering another live service operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-lock-'));
  try {
    const unlock = acquireRuntimeLock(join(root, 'runtime.sqlite'));
    assert.throws(() => acquireRuntimeLock(join(root, 'runtime.sqlite')), /Runtime lock exists/);
    unlock(); const secondUnlock = acquireRuntimeLock(join(root, 'runtime.sqlite')); secondUnlock();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('delivery worker integrates through runtime HTTP service to real commits and QA, then blocks missing release adapter', async t => {
  const codex = async ({ cwd, kind }) => {
    if (kind === 'design') { mkdirSync(join(cwd, '.delivery')); writeFileSync(join(cwd, '.delivery/design.md'), '# Booking design\n'); }
    if (kind === 'implementation') writeFileSync(join(cwd, 'booking.mjs'), 'export const bookingId = "confirmed";\n');
    return { summary: 'Task processed', blocked: false, reviewPassed: kind === 'review' };
  };
  const { store, worker: runtimeWorker, repositories } = await fixture(t, { codex, acceptanceChecks: [{ criterion: spec.acceptanceCriteria[0], argv: [process.execPath, '--input-type=module', '-e', 'import("./booking.mjs").then(m=>{if(m.bookingId!=="confirmed")process.exit(1)})'] }] });
  const token = 'integration-runtime-test-token-1234567890123';
  const server = createRuntimeApp({ store, repositories, token }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const runtime = createRuntime({ url: 'https://runtime.example', token, fetchImpl: (url, options) => fetch(local + new URL(url).pathname, options) });
  const memory = new Memory(':memory:'); t.after(() => memory.close());
  const delivery = new DeliveryStore(memory); const project = memory.create('App', 'Booking app');
  memory.saveSpec(project.id, spec); memory.approve(project.id, 1, 1, false);
  const run = delivery.start(project.id, { repository: 'owner/app' });
  const manager = { model: 'integration-test', async decompose() { return { tasks: [{ key: 'booking', title: 'Booking', instructions: 'Implement booking ID', dependencies: [], criteria: [0] }], usage: {} }; } };
  const deliveryWorker = new DeliveryWorker({ store: delivery, manager, runtime, pollDelayMs: 0 });
  for (let i = 0; i < 15; i++) { await deliveryWorker.tick(); await runtimeWorker.tick(); }
  const completed = delivery.run(run.id);
  assert.deepEqual(completed.jobs.slice(0, 5).map(job => job.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
  assert.match(completed.jobs.find(job => job.kind === 'implementation').result.commitSha, /^[a-f0-9]{40}$/);
  assert.equal(completed.jobs.find(job => job.kind === 'qa').result.acceptanceResults[0].passed, true);
  assert.equal(completed.status, 'blocked'); assert.equal(completed.jobs.at(-1).error_code, 'RELEASE_ADAPTER_MISSING');
  assert.notEqual(memory.project(project.id).stage, 'delivered');
});
