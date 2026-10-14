import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Memory, AppError } from '../src/memory.mjs';
import { GitHubApi, GitHubPublisher, validateSnapshot } from '../src/github-release.mjs';
import { ReleaseStore } from '../src/release-store.mjs';
import { ReleaseEngine } from '../src/release-engine.mjs';
import { createReleaseApp } from '../src/release-server.mjs';
import { createReleaseClient } from '../src/release-client.mjs';
import { OperationStore } from '../src/operation-store.mjs';

const sha = character => character.repeat(40);
const policy = { baseBranch: 'main', workflow: 'delivery.yml', workflowBlobSha: sha('f'), environment: 'preview', allowedDeploymentOrigins: ['https://app.example'] };
function snapshot() {
  const content = Buffer.from('Generated app\n'); const hash = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  return { runId: randomUUID(), repository: 'owner/app', baseSha: sha('b'), sourceSha: sha('a'), treeSha: sha('c'), tree: [
    { path: '.github/workflows/delivery.yml', mode: '100644', type: 'blob', sha: sha('f') },
    { path: 'README.md', mode: '100644', type: 'blob', sha: hash }
  ], blobs: [{ sha: hash, content: content.toString('base64') }] };
}
function mockGitHub(release, overrides = {}) {
  const calls = []; let branchSha; let dispatched = 0;
  const api = { calls, get dispatched() { return dispatched; }, async request(path, method = 'GET', body) {
    calls.push({ path, method, body });
    if (overrides.request) { const result = await overrides.request(path, method, body); if (result !== undefined) return result; }
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: overrides.baseSha ?? sha('b') } };
    if (path.endsWith(`/git/commits/${sha('b')}`)) return { tree: { sha: sha('e') } };
    if (path.includes('/git/trees/') && method === 'GET') return { truncated: false, tree: [{ path: '.github/workflows/delivery.yml', mode: '100644', type: 'blob', sha: sha('f') }, { path: 'README.md', mode: '100644', type: 'blob', sha: sha('0') }] };
    if (path.endsWith('/git/blobs')) return { sha: release.request.blobs[0].sha };
    if (path.endsWith('/git/trees')) return { sha: overrides.treeSha ?? sha('c') };
    if (path.endsWith('/git/commits')) return { sha: sha('d') };
    if (path.includes('/git/ref/heads/delivery/')) {
      if (!branchSha && !overrides.branchSha) { const error = new AppError(502, 'NOT_FOUND', 'Missing'); error.upstreamStatus = 404; throw error; }
      return { object: { sha: overrides.branchSha ?? branchSha } };
    }
    if (path.endsWith('/git/refs')) { branchSha = body.sha; return { object: { sha: branchSha } }; }
    if (path.includes('/pulls?')) return [];
    if (path.endsWith('/pulls')) return { head: { sha: sha('d') }, html_url: 'https://github.com/owner/app/pull/1' };
    if (path.endsWith('/dispatches')) { dispatched++; return overrides.noWorkflow ? null : { workflow_run_id: 123 }; }
    const workflow = { id: 123, head_sha: overrides.workflowSha ?? sha('d'), head_branch: `delivery/${release.run_id}`, event: 'workflow_dispatch', display_title: `delivery-${release.id}`, status: 'completed', conclusion: overrides.conclusion ?? 'success', html_url: 'https://github.com/owner/app/actions/runs/123' };
    if (path.includes('/actions/workflows/') && path.includes('/runs?')) return { workflow_runs: overrides.noWorkflow ? [] : [workflow] };
    if (path.endsWith('/actions/runs/123')) return workflow;
    if (path.includes('/deployments?')) return [{ id: 456, sha: sha('d'), environment: 'preview', payload: { delivery_release_id: release.id, workflow_run_id: 123 } }];
    if (path.includes('/deployments/456/statuses')) return [{ state: overrides.deploymentState ?? 'success', environment_url: overrides.deploymentUrl ?? 'https://app.example', url: 'https://api.github.com/repos/owner/app/deployments/456/statuses/789' }];
    throw new Error(`Unexpected request ${method} ${path}`);
  } };
  return api;
}
function setup(t, overrides = {}) {
  const memory = new Memory(':memory:'); t.after(() => memory.close()); const store = new ReleaseStore(memory);
  const release = store.submit('operation:1', snapshot()); const api = mockGitHub(release, overrides);
  let smokeCalls = 0;
  const engine = new ReleaseEngine({ store, api, repositories: { 'owner/app': policy }, publicUrl: 'https://release.example', pollDelayMs: 0,
    fetchImpl: async (url, options) => { smokeCalls++; assert.equal(String(url), 'https://app.example/.well-known/delivery.json'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined); return Response.json({ commitSha: overrides.liveSha ?? sha('d'), releaseId: release.id }); } });
  return { memory, store, release, api, engine, get smokeCalls() { return smokeCalls; } };
}
test('snapshot validates blob bytes, modes, paths and Git object hashes', () => {
  assert.equal(validateSnapshot(snapshot()).tree.length, 2);
  const broken = snapshot(); broken.blobs[0].content = Buffer.from('different').toString('base64');
  assert.throws(() => validateSnapshot(broken), error => error.code === 'BLOB_HASH_MISMATCH');
  const unsafe = snapshot(); unsafe.tree[0].path = '../escape'; assert.throws(() => validateSnapshot(unsafe));
  const duplicate = snapshot(); duplicate.tree.push(duplicate.tree[0]); assert.throws(() => validateSnapshot(duplicate));
});
test('publishing creates exact snapshot tree, delivery branch and PR without moving main', async t => {
  const { engine, store, release, api } = setup(t);
  await engine.tick(); const state = store.get(release.id).checkpoint;
  assert.equal(state.publishedSha, sha('d')); assert.equal(state.pullRequestUrl, 'https://github.com/owner/app/pull/1');
  assert.equal(api.calls.find(call => call.path.endsWith('/git/refs')).body.ref, `refs/heads/delivery/${release.run_id}`);
  assert.ok(!api.calls.some(call => call.method === 'PATCH' || call.method === 'DELETE'));
  assert.deepEqual(api.calls.find(call => call.path.endsWith('/git/commits') && call.method === 'POST').body.parents, [sha('b')]);
});
test('moved base and existing conflicting delivery branch block publication', async t => {
  const moved = setup(t, { baseSha: sha('1') }); await moved.engine.tick(); assert.equal(moved.store.get(moved.release.id).error_code, 'BASE_BRANCH_MOVED');
  const conflict = setup(t, { branchSha: sha('2') }); await conflict.engine.tick(); assert.equal(conflict.store.get(conflict.release.id).error_code, 'DELIVERY_BRANCH_CONFLICT');
  assert.ok(!conflict.api.calls.some(call => call.method === 'PATCH'));
});
test('generated workflow edits and tree-hash mismatch cannot be published as trusted releases', async t => {
  const { store, release, api } = setup(t);
  const changed = { ...release, request: { ...release.request, tree: release.request.tree.map(entry => entry.path.startsWith('.github/') ? { ...entry, sha: sha('9') } : entry) } };
  await assert.rejects(() => new GitHubPublisher(api).publish(changed, policy, () => {}), error => error.code === 'WORKFLOW_POLICY_CHANGED');
  const mismatch = setup(t, { treeSha: sha('8') }); await mismatch.engine.tick(); assert.equal(mismatch.store.get(mismatch.release.id).error_code, 'TREE_HASH_MISMATCH');
  assert.equal(store.get(release.id).status, 'queued');
});
test('release succeeds only for exact pipeline, deployment and live commit/release marker', async t => {
  const context = setup(t);
  for (let i = 0; i < 3; i++) await context.engine.tick();
  const completed = context.store.get(context.release.id);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.result.publishedCommitSha, sha('d')); assert.equal(completed.result.smokePassed, true);
  assert.equal(context.api.dispatched, 1); assert.equal(context.smokeCalls, 1);
  assert.equal(completed.checkpoint.workflowRunId, 123); assert.equal(completed.checkpoint.deploymentId, 456);
});
test('wrong pipeline commit, failed pipeline and stale live app never become delivered', async t => {
  for (const [overrides, code] of [[{ workflowSha: sha('3') }, 'WORKFLOW_COMMIT_MISMATCH'], [{ conclusion: 'failure' }, 'RELEASE_PIPELINE_FAILED'], [{ liveSha: sha('4') }, 'DEPLOYED_VERSION_MISMATCH']]) {
    const { store, release, engine } = setup(t, overrides);
    for (let i = 0; i < 3; i++) await engine.tick();
    assert.equal(store.get(release.id).status, 'failed'); assert.equal(store.get(release.id).error_code, code); assert.equal(store.get(release.id).result, null);
  }
});
test('deployment failure and non-allowlisted host block smoke requests', async t => {
  for (const [overrides, code] of [[{ deploymentState: 'failure' }, 'DEPLOYMENT_FAILED'], [{ deploymentUrl: 'https://untrusted.example' }, 'DEPLOYMENT_ORIGIN_NOT_ALLOWED']]) {
    const context = setup(t, overrides); for (let i = 0; i < 3; i++) await context.engine.tick();
    assert.equal(context.store.get(context.release.id).error_code, code); assert.equal(context.smokeCalls, 0);
  }
});
test('missing pipeline run remains pending without duplicate dispatch', async t => {
  const { store, release, engine, api } = setup(t, { noWorkflow: true });
  for (let i = 0; i < 5; i++) await engine.tick();
  assert.equal(store.get(release.id).status, 'running'); assert.equal(api.dispatched, 1);
});
test('persisted dispatch checkpoint survives service restart without re-dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-restart-')); const path = join(root, 'release.sqlite'); let memory = new Memory(path);
  try {
    let store = new ReleaseStore(memory); const release = store.submit('operation:1', snapshot());
    const firstApi = mockGitHub(release); let engine = new ReleaseEngine({ store, api: firstApi, repositories: { 'owner/app': policy }, publicUrl: 'https://release.example', pollDelayMs: 0 });
    await engine.tick(); await engine.tick(); assert.equal(firstApi.dispatched, 1); memory.close();
    memory = new Memory(path); store = new ReleaseStore(memory); const secondApi = mockGitHub(store.get(release.id));
    engine = new ReleaseEngine({ store, api: secondApi, repositories: { 'owner/app': policy }, publicUrl: 'https://release.example', pollDelayMs: 0, fetchImpl: async () => Response.json({ commitSha: sha('d'), releaseId: release.id }) });
    await engine.tick(); assert.equal(store.get(release.id).status, 'succeeded'); assert.equal(secondApi.dispatched, 0);
  } finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});
test('release timeout reports failure instead of dispatching again', async t => {
  const { store, release, engine, api } = setup(t);
  store.save(release.id, { startedAt: Date.now() - 2000000 }, 0); await engine.tick();
  assert.equal(store.get(release.id).error_code, 'RELEASE_TIMEOUT'); assert.equal(api.dispatched, 0);
});
test('release API protects evidence, allowlists repositories and deduplicates snapshots', async t => {
  const { store, release } = setup(t); const token = 'release-service-test-token-12345678901234567890';
  const server = createReleaseApp({ store, repositories: { 'owner/app': policy }, token }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'operation:1' };
  assert.equal((await fetch(base + `/releases/${release.id}/evidence`)).status, 401);
  const submitted = await fetch(base + '/releases', { method: 'POST', headers, body: JSON.stringify(release.request) });
  assert.equal(submitted.status, 202); assert.equal((await submitted.json()).id, release.id);
  assert.equal((await fetch(base + '/releases', { method: 'POST', headers, body: JSON.stringify({ ...snapshot(), repository: 'unknown/app' }) })).status, 403);
  const changed = snapshot(); assert.throws(() => store.submit('operation:1', changed), error => error.code === 'RELEASE_CONFLICT');
});
test('GitHub REST credentials are sent only to api.github.com and provider errors are sanitized', async () => {
  const api = new GitHubApi({ token: 'test-release-secret', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/owner/app/git/refs'); assert.equal(options.headers.Authorization, 'Bearer test-release-secret'); assert.equal(options.redirect, 'error');
    return new Response('sensitive upstream details', { status: 403 });
  } });
  await assert.rejects(() => api.request('/repos/owner/app/git/refs', 'POST', {}), error => error.upstreamStatus === 403 && !error.message.includes('sensitive'));
});
test('runtime release client preserves request idempotency and requires terminal success', async () => {
  const id = randomUUID(); let polls = 0;
  const client = createReleaseClient({ url: 'https://release.example', token: 'test', pollDelayMs: 0, fetchImpl: async (url, options) => {
    if (options.method === 'POST') { assert.equal(options.headers['Idempotency-Key'], 'operation:1'); return Response.json({ id }); }
    return Response.json(++polls === 1 ? { status: 'running' } : { status: 'succeeded', result: { smokePassed: true } });
  } });
  assert.equal(await client.start(snapshot(), 'operation:1'), id); assert.equal((await client.wait(id)).smokePassed, true);
});
test('runtime only releases a commit with matching persisted review and QA evidence', t => {
  const memory = new Memory(':memory:'); t.after(() => memory.close()); const store = new OperationStore(memory);
  const runId = randomUUID(); assert.throws(() => store.releaseReady(runId, sha('a'), 1), error => error.code === 'RELEASE_GATES_MISSING');
  const specification = { title: 'App', goal: 'Goal', users: ['User'], inScope: ['Feature'], outOfScope: [], acceptanceCriteria: ['Works'], assumptions: [], openQuestions: [] };
  for (const kind of ['review', 'qa']) {
    const operation = store.submit(kind, { runId, jobId: randomUUID(), repository: 'owner/app', specificationVersion: 1, kind, payload: { specification }, dependencies: [] }); store.claim();
    store.complete(operation.id, kind === 'review' ? { reviewPassed: true } : { acceptanceResults: [{ index: 0, passed: true }] }, { headAfter: sha('a') });
  }
  assert.doesNotThrow(() => store.releaseReady(runId, sha('a'), 1));
  assert.throws(() => store.releaseReady(runId, sha('b'), 1), error => error.code === 'RELEASE_GATES_MISSING');
});
