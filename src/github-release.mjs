import { createHash } from 'node:crypto';
import { AppError } from './memory.mjs';

export function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9-]{36}$/.test(value.runId ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? '')) throw new AppError(400, 'INVALID_SNAPSHOT', 'Run ID and repository required');
  for (const key of ['baseSha', 'sourceSha', 'treeSha']) if (!/^[a-f0-9]{40}$/.test(value[key] ?? '')) throw new AppError(400, 'INVALID_SNAPSHOT', 'GitHub SHA-1 commit/tree identifiers required');
  if (!Array.isArray(value.tree) || !value.tree.length || value.tree.length > 2000 || !Array.isArray(value.blobs) || value.blobs.length > 2000) throw new AppError(400, 'INVALID_SNAPSHOT', 'Snapshot must contain 1–2000 entries');
  const paths = new Set();
  const tree = value.tree.map(entry => {
    if (!entry || typeof entry.path !== 'string' || entry.path.length > 1000 || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || /[\0\r\n]/.test(entry.path) || paths.has(entry.path) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha ?? '')) throw new AppError(400, 'INVALID_SNAPSHOT', 'Unsupported or duplicate snapshot entry');
    paths.add(entry.path); return { path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha };
  });
  const hashes = new Set(); let bytes = 0;
  const blobs = value.blobs.map(blob => {
    if (!blob || !/^[a-f0-9]{40}$/.test(blob.sha ?? '') || hashes.has(blob.sha) || typeof blob.content !== 'string') throw new AppError(400, 'INVALID_SNAPSHOT', 'Invalid blob');
    const content = Buffer.from(blob.content, 'base64');
    if (content.toString('base64') !== blob.content || content.length > 4000000) throw new AppError(400, 'INVALID_SNAPSHOT', 'Blob encoding or size invalid');
    bytes += content.length;
    const hash = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (hash !== blob.sha) throw new AppError(400, 'BLOB_HASH_MISMATCH', 'Snapshot blob does not match its Git object hash');
    hashes.add(hash); return { sha: hash, content: blob.content };
  });
  if (bytes > 8000000 || blobs.some(blob => !tree.some(entry => entry.sha === blob.sha))) throw new AppError(400, 'INVALID_SNAPSHOT', 'Snapshot exceeds size limit or contains unused blobs');
  return { runId: value.runId, repository: value.repository, baseSha: value.baseSha, sourceSha: value.sourceSha, treeSha: value.treeSha, tree, blobs };
}
export class GitHubApi {
  constructor({ token, fetchImpl = fetch }) { this.token = token; this.fetch = fetchImpl; }
  async request(path, method = 'GET', body) {
    if (!this.token) throw new AppError(503, 'GITHUB_RELEASE_NOT_CONFIGURED', 'Configure GITHUB_RELEASE_TOKEN on the trusted release service');
    if (!path.startsWith('/repos/') || path.includes('..') || path.includes('#')) throw new AppError(500, 'INVALID_GITHUB_PATH', 'Invalid GitHub request path');
    let response;
    try {
      response = await this.fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new AppError(502, 'GITHUB_RELEASE_UNAVAILABLE', 'GitHub release request failed; checkpoint requires recovery'); }
    if (!response.ok) { const error = new AppError(502, 'GITHUB_RELEASE_REJECTED', 'GitHub rejected the release request'); error.upstreamStatus = response.status; throw error; }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new AppError(502, 'INVALID_GITHUB_RESPONSE', 'GitHub returned invalid JSON'); }
  }
}
export class GitHubPublisher {
  constructor(api) { this.api = api; }
  async publish(release, config, save) {
    const request = release.request; const prefix = `/repos/${request.repository}`;
    let state = { ...release.checkpoint };
    const baseBranch = config.baseBranch ?? 'main';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(baseBranch) || !/^[a-f0-9]{40}$/.test(config.workflowBlobSha ?? '') || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(config.workflow ?? '')) throw new AppError(503, 'RELEASE_POLICY_MISSING', 'Configure base branch, trusted workflow filename and pinned workflow blob SHA');
    if (!state.publishedSha) {
      const base = await this.api.request(`${prefix}/git/ref/heads/${baseBranch}`);
      if (base.object?.sha !== request.baseSha) throw new AppError(409, 'BASE_BRANCH_MOVED', 'Source base differs from GitHub base branch; rebase/revalidate before publishing');
      const commit = await this.api.request(`${prefix}/git/commits/${request.baseSha}`);
      const baseTree = await this.api.request(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
      if (baseTree.truncated || !Array.isArray(baseTree.tree)) throw new AppError(409, 'GITHUB_TREE_LIMIT', 'Complete base tree required');
      const original = new Map(baseTree.tree.filter(entry => entry.type !== 'tree').map(entry => [entry.path, entry]));
      const candidate = new Map(request.tree.map(entry => [entry.path, entry]));
      for (const path of new Set([...original.keys(), ...candidate.keys()])) {
        if (path === '.github' || path.startsWith('.github/')) {
          if (original.get(path)?.sha !== candidate.get(path)?.sha || original.get(path)?.mode !== candidate.get(path)?.mode) throw new AppError(409, 'WORKFLOW_POLICY_CHANGED', 'Generated changes cannot alter trusted .github automation');
        }
      }
      if (original.get(`.github/workflows/${config.workflow}`)?.sha !== config.workflowBlobSha) throw new AppError(409, 'WORKFLOW_POLICY_CHANGED', 'Configured workflow pin differs from base repository');
      const known = new Set([...original.values()].map(entry => entry.sha));
      const blobs = new Map(request.blobs.map(blob => [blob.sha, blob]));
      for (const entry of request.tree) {
        if (known.has(entry.sha)) continue;
        const blob = blobs.get(entry.sha);
        if (!blob) throw new AppError(400, 'BLOB_MISSING', 'New Git object content is missing');
        const uploaded = await this.api.request(`${prefix}/git/blobs`, 'POST', { content: blob.content, encoding: 'base64' });
        if (uploaded.sha !== entry.sha) throw new AppError(502, 'BLOB_HASH_MISMATCH', 'Published blob does not match source');
        known.add(entry.sha);
      }
      const tree = await this.api.request(`${prefix}/git/trees`, 'POST', { tree: request.tree });
      if (tree.sha !== request.treeSha) throw new AppError(502, 'TREE_HASH_MISMATCH', 'Published tree differs from tested source tree');
      const identity = { name: 'AI Delivery Release', email: 'delivery-release@localhost', date: release.created_at };
      const published = await this.api.request(`${prefix}/git/commits`, 'POST', { tree: tree.sha, parents: [request.baseSha], message: `AI delivery ${release.id}`, author: identity, committer: identity });
      if (!/^[a-f0-9]{40}$/.test(published.sha ?? '')) throw new AppError(502, 'INVALID_GITHUB_RESPONSE', 'Published commit SHA missing');
      state = { ...state, publishedSha: published.sha, branch: `delivery/${request.runId}` }; save(state);
    }
    let ref;
    try { ref = await this.api.request(`${prefix}/git/ref/heads/${state.branch}`); } catch (error) { if (error.upstreamStatus !== 404) throw error; }
    if (ref && ref.object?.sha !== state.publishedSha) throw new AppError(409, 'DELIVERY_BRANCH_CONFLICT', 'Delivery branch contains a different commit; it will not be overwritten');
    if (!ref) await this.api.request(`${prefix}/git/refs`, 'POST', { ref: `refs/heads/${state.branch}`, sha: state.publishedSha });
    if (!state.pullRequestUrl) {
      const owner = request.repository.split('/')[0];
      const pulls = await this.api.request(`${prefix}/pulls?state=open&head=${encodeURIComponent(`${owner}:${state.branch}`)}&base=${encodeURIComponent(baseBranch)}`);
      let pull = Array.isArray(pulls) ? pulls[0] : null;
      if (!pull) pull = await this.api.request(`${prefix}/pulls`, 'POST', { title: `AI delivery: ${request.runId}`, head: state.branch, base: baseBranch, body: `Generated delivery candidate for approved run ${request.runId}. Source tree: ${request.treeSha}. CI and deployment evidence are recorded by the release service.`, draft: false });
      if (pull.head?.sha !== state.publishedSha || typeof pull.html_url !== 'string' || !pull.html_url.startsWith('https://github.com/')) throw new AppError(409, 'PR_COMMIT_MISMATCH', 'Pull request must reference the published commit');
      state = { ...state, pullRequestUrl: pull.html_url }; save(state);
    }
    return state;
  }
}
