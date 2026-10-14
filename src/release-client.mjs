import { AppError } from './memory.mjs';

export function createReleaseClient({ url, token, fetchImpl = fetch, pollDelayMs = 2000, timeoutMs = 1500000 }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('RELEASE_SERVICE_URL must be HTTPS without embedded credentials');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  async function request(path, method, body, key) {
    if (!token) throw new AppError(503, 'RELEASE_ADAPTER_MISSING', 'Release service token is not configured');
    let response;
    try { response = await fetchImpl(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new AppError(502, 'RELEASE_SERVICE_UNAVAILABLE', 'Release service request failed; use its persisted idempotency checkpoint to reconcile'); }
    if (!response.ok) throw new AppError(502, 'RELEASE_SERVICE_REJECTED', 'Release service rejected the request');
    try { return await response.json(); } catch { throw new AppError(502, 'INVALID_RELEASE_RESPONSE', 'Release service returned invalid JSON'); }
  }
  return {
    async start(snapshot, key) {
      const result = await request('releases', 'POST', snapshot, key);
      if (!/^[a-f0-9-]{36}$/.test(result.id ?? '')) throw new AppError(502, 'INVALID_RELEASE_RESPONSE', 'Release service returned invalid operation ID');
      return result.id;
    },
    async wait(id) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const release = await request(`releases/${id}`, 'GET');
        if (release.status === 'succeeded') return release.result;
        if (release.status === 'failed') throw new AppError(409, /^[A-Z][A-Z0-9_]{0,63}$/.test(release.error ?? '') ? release.error : 'RELEASE_FAILED', 'Trusted release service reported a failure');
        if (!['queued', 'running'].includes(release.status)) throw new AppError(502, 'INVALID_RELEASE_RESPONSE', 'Unknown release operation state');
        await new Promise(done => setTimeout(done, pollDelayMs));
      }
      throw new AppError(409, 'RELEASE_WAIT_TIMEOUT', 'Release remains pending; reconcile its saved remote ID');
    }
  };
}
