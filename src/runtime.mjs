import { AppError } from './memory.mjs';

// This is our runtime-service protocol, not an OpenAI API endpoint.
export function createRuntime({ url, token, fetchImpl = fetch }) {
  let base;
  if (url) {
    base = new URL(url);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('CODING_RUNTIME_URL must be an HTTPS service URL without credentials, query or fragment');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
  }
  async function request(path, method, payload, key) {
    if (!base || !token) throw new AppError(503, 'RUNTIME_NOT_CONFIGURED', 'Configure CODING_RUNTIME_URL and CODING_RUNTIME_TOKEN');
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
    } catch {
      const error = new AppError(502, 'RUNTIME_UNAVAILABLE', 'Runtime request failed; preserve its idempotency checkpoint'); error.retryable = true; throw error;
    }
    if (!response.ok) {
      const error = new AppError(502, 'RUNTIME_UPSTREAM_ERROR', 'Runtime rejected the request'); error.retryable = response.status >= 500 || response.status === 429; throw error;
    }
    const text = await response.text();
    if (text.length > 1000000) throw new AppError(502, 'INVALID_RUNTIME_RESPONSE', 'Runtime response exceeds size limit');
    try { return JSON.parse(text); } catch { throw new AppError(502, 'INVALID_RUNTIME_RESPONSE', 'Runtime returned invalid JSON'); }
  }
  return {
    async start(payload, key) {
      const operation = await request('operations', 'POST', payload, key);
      if (typeof operation.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operation.id)) throw new AppError(502, 'INVALID_RUNTIME_RESPONSE', 'Runtime must return a valid operation ID');
      return operation.id;
    },
    async poll(id) { return request(`operations/${encodeURIComponent(id)}`, 'GET'); }
  };
}

export function validateEvidence(kind, result, criteriaCount) {
  const reference = value => typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value);
  if (!result || typeof result !== 'object' || !reference(result.evidenceUrl)) throw new AppError(502, 'EVIDENCE_REQUIRED', 'Trusted runtime evidence URL required');
  if (kind === 'design' && !reference(result.designUrl)) throw new AppError(502, 'EVIDENCE_REQUIRED', 'Design artifact required');
  if (kind === 'implementation' && (!/^[a-f0-9]{40,64}$/.test(result.commitSha ?? '') || !reference(result.diffUrl))) throw new AppError(502, 'EVIDENCE_REQUIRED', 'Implementation requires a commit and diff artifact');
  if (kind === 'review' && result.reviewPassed !== true) throw new AppError(409, 'REVIEW_FAILED', 'Review did not pass');
  if (kind === 'qa') {
    const covered = new Set();
    if (!Array.isArray(result.acceptanceResults) || result.acceptanceResults.some(check => {
      if (!check || !Number.isInteger(check.index) || check.index < 0 || check.index >= criteriaCount || check.passed !== true || !reference(check.evidenceUrl)) return true;
      covered.add(check.index); return false;
    }) || covered.size !== criteriaCount) throw new AppError(409, 'ACCEPTANCE_FAILED', 'Every criterion requires passing test evidence');
  }
  if (kind === 'release' && (!reference(result.deployedUrl) || result.smokePassed !== true || !reference(result.smokeEvidenceUrl))) throw new AppError(409, 'RELEASE_FAILED', 'Deployment URL and passing smoke-test evidence required');
  return result;
}
