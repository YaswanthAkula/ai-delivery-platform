import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Memory } from '../src/memory.mjs';
import { createPlanner } from '../src/planner.mjs';
import { createApp } from '../src/server.mjs';

const token = 'test-token-for-local-tests-only-1234567890';
const spec = () => ({ title: 'Appointment app', goal: 'Book appointments', users: ['Receptionist'], inScope: ['Appointment booking'], outOfScope: ['Billing'], acceptanceCriteria: ['A valid booking returns a confirmation ID'], assumptions: [], openQuestions: [] });
async function fixture(t, planner = createPlanner({})) {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-test-'));
  const memory = new Memory(join(directory, 'memory.sqlite'));
  const server = createApp({ memory, planner, token, maxPlanningTurns: 2 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); memory.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', data, authenticated = true) => {
    const response = await fetch(base + path, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  return { memory, request };
}
test('project API requires authentication and validates input', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/health', 'GET', undefined, false)).status, 200);
  assert.equal((await request('/projects', 'GET', undefined, false)).status, 401);
  assert.equal((await request('/projects', 'POST', { name: '', idea: 'x' })).status, 400);
  const project = await request('/projects', 'POST', { name: 'Hospital', idea: 'Appointments' });
  assert.equal(project.status, 201);
  assert.equal((await request('/projects')).data.projects.length, 1);
  assert.equal((await request(`/projects/${project.data.id}`)).data.stage, 'planning');
});
test('missing model credentials never create fabricated messages or specifications', async t => {
  const { request } = await fixture(t);
  const project = (await request('/projects', 'POST', { name: 'Hospital', idea: 'Appointments' })).data;
  const result = await request(`/projects/${project.id}/messages`, 'POST', { content: 'Start planning' });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'PLANNER_NOT_CONFIGURED');
  assert.deepEqual((await request(`/projects/${project.id}/messages`)).data.messages, []);
});
test('planner adapter saves real-shaped response, transcript, draft and token usage', async t => {
  const planner = createPlanner({ apiKey: 'test-secret', model: 'test-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(options.body);
    assert.equal(payload.store, false); assert.equal(payload.model, 'test-model');
    assert.match(payload.input, /Appointments/);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ reply: 'Review this draft', specification: spec() }) }] }], usage: { input_tokens: 100, output_tokens: 50 } });
  } });
  const { request } = await fixture(t, planner);
  const project = (await request('/projects', 'POST', { name: 'Hospital', idea: 'Appointments' })).data;
  const result = await request(`/projects/${project.id}/messages`, 'POST', { content: 'Receptionist books appointments' });
  assert.equal(result.status, 200); assert.equal(result.data.specificationVersion, 1);
  assert.equal((await request(`/projects/${project.id}/messages`)).data.messages.length, 2);
  assert.deepEqual((await request(`/projects/${project.id}`)).data.usage, { input_tokens: 100, output_tokens: 50 });
});
test('approval rejects unresolved, stale and unacknowledged plans then freezes approved version', async t => {
  const { request } = await fixture(t);
  const project = (await request('/projects', 'POST', { name: 'Hospital', idea: 'Appointments' })).data;
  const path = `/projects/${project.id}`;
  await request(path + '/specifications', 'POST', { ...spec(), openQuestions: ['Which hospital?'] });
  assert.equal((await request(path + '/approve', 'POST', { version: 1, expectedRevision: 1 })).data.error, 'OPEN_QUESTIONS');
  await request(path + '/specifications', 'POST', { ...spec(), assumptions: ['One hospital'] });
  assert.equal((await request(path + '/approve', 'POST', { version: 1, expectedRevision: 2 })).data.error, 'STALE_SPEC');
  assert.equal((await request(path + '/approve', 'POST', { version: 2, expectedRevision: 1 })).data.error, 'STALE_PLAN');
  assert.equal((await request(path + '/approve', 'POST', { version: 2, expectedRevision: 2 })).data.error, 'ASSUMPTIONS_UNCONFIRMED');
  const approved = await request(path + '/approve', 'POST', { version: 2, expectedRevision: 2, acknowledgeAssumptions: true });
  assert.equal(approved.status, 200); assert.equal(approved.data.stage, 'ready');
  assert.equal((await request(path + '/messages', 'POST', { content: 'Change it' })).status, 409);
  assert.equal((await request(path + '/specifications', 'POST', spec())).status, 409);
  assert.ok((await request(path + '/specifications')).data.specifications[1].approved_at);
});
test('SQLite preserves approved specification and project state across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-restart-')); const path = join(directory, 'memory.sqlite');
  let memory = new Memory(path);
  try {
    const project = memory.create('Persistent', 'Keep decisions');
    memory.saveSpec(project.id, spec()); memory.approve(project.id, 1, 1, false); memory.close();
    memory = new Memory(path);
    assert.equal(memory.project(project.id).stage, 'ready');
    assert.equal(memory.specs(project.id)[0].content.title, 'Appointment app');
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('invalid paid model response records usage without saving a partial turn', async t => {
  const planner = createPlanner({ apiKey: 'secret', model: 'test', fetchImpl: async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not JSON' }] }], usage: { input_tokens: 12, output_tokens: 3 } }) });
  const { request } = await fixture(t, planner);
  const project = (await request('/projects', 'POST', { name: 'App', idea: 'Idea' })).data;
  assert.equal((await request(`/projects/${project.id}/messages`, 'POST', { content: 'Plan it' })).data.error, 'INVALID_PLANNER_RESPONSE');
  const saved = (await request(`/projects/${project.id}`)).data;
  assert.deepEqual(saved.usage, { input_tokens: 12, output_tokens: 3 }); assert.equal(saved.revision, 0);
});
test('concurrent planning and approval cannot overwrite a running conversation', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let started; const start = new Promise(resolve => { started = resolve; });
  const planner = { model: 'test', async plan() { started(); await waiting; return { reply: 'Question', specification: null, usage: {} }; } };
  const { request } = await fixture(t, planner);
  const project = (await request('/projects', 'POST', { name: 'App', idea: 'Idea' })).data;
  await request(`/projects/${project.id}/specifications`, 'POST', spec());
  const turn = request(`/projects/${project.id}/messages`, 'POST', { content: 'Discuss' }); await start;
  assert.equal((await request(`/projects/${project.id}/messages`, 'POST', { content: 'Again' })).data.error, 'PROJECT_BUSY');
  assert.equal((await request(`/projects/${project.id}/approve`, 'POST', { version: 1, expectedRevision: 1 })).data.error, 'PROJECT_BUSY');
  release(); assert.equal((await turn).status, 200);
  assert.equal((await request(`/projects/${project.id}/approve`, 'POST', { version: 1, expectedRevision: 2 })).data.error, 'STALE_SPEC');
});
test('planner turn limits stop additional model calls', async t => {
  let calls = 0;
  const planner = { model: 'test', async plan() { calls++; return { reply: 'Next question', specification: null, usage: {} }; } };
  const { request } = await fixture(t, planner);
  const project = (await request('/projects', 'POST', { name: 'App', idea: 'Idea' })).data;
  for (let i = 0; i < 2; i++) assert.equal((await request(`/projects/${project.id}/messages`, 'POST', { content: 'Discuss' })).status, 200);
  assert.equal((await request(`/projects/${project.id}/messages`, 'POST', { content: 'Discuss' })).data.error, 'TURN_LIMIT');
  assert.equal(calls, 2);
});
test('planner sanitizes provider errors and rejects oversized context before API call', async () => {
  const planner = createPlanner({ apiKey: 'secret', model: 'test', fetchImpl: async () => new Response('sensitive details', { status: 401 }) });
  await assert.rejects(() => planner.plan({ project: { name: 'x', idea: 'x' }, messages: [], input: 'x' }), error => error.code === 'PLANNER_UPSTREAM_ERROR' && !error.message.includes('sensitive'));
  const limited = createPlanner({ apiKey: 'secret', model: 'test', maxContextCharacters: 1, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => limited.plan({ project: { name: 'x', idea: 'x' }, messages: [], input: 'x' }), error => error.code === 'CONTEXT_LIMIT');
});
