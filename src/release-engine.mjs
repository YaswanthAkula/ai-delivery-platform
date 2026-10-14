import { AppError } from './memory.mjs';
import { GitHubPublisher } from './github-release.mjs';

export class ReleaseEngine {
  constructor({ store, repositories, api, publicUrl, fetchImpl = fetch, pollDelayMs = 2000, timeoutMs = 1800000 }) {
    this.store = store; this.repositories = repositories; this.api = api; this.publisher = new GitHubPublisher(api);
    const base = new URL(publicUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('RELEASE_PUBLIC_URL must be HTTPS without credentials');
    this.publicUrl = base.toString().replace(/\/$/, ''); this.fetch = fetchImpl;
    this.pollDelayMs = pollDelayMs; this.timeoutMs = timeoutMs; this.busy = false;
  }
  async tick() {
    if (this.busy) return false;
    const release = this.store.next(); if (!release) return false;
    this.busy = true;
    try {
      if (!Object.hasOwn(this.repositories, release.repository)) throw new AppError(403, 'REPOSITORY_NOT_ALLOWED', 'Release repository is not allowlisted');
      const config = this.repositories[release.repository];
      if (!config.environment || !Array.isArray(config.allowedDeploymentOrigins) || !config.allowedDeploymentOrigins.length) throw new AppError(503, 'RELEASE_POLICY_MISSING', 'Configure deployment environment and allowed HTTPS origins');
      let state = { ...release.checkpoint };
      const save = value => { state = value; this.store.save(release.id, value, this.pollDelayMs); };
      if (!state.startedAt) save({ ...state, startedAt: Date.now() });
      if (Date.now() - state.startedAt >= this.timeoutMs) throw new AppError(409, 'RELEASE_TIMEOUT', 'Release deadline exceeded; reconcile its recorded pipeline');
      if (!state.pullRequestUrl) {
        state = await this.publisher.publish({ ...release, checkpoint: state }, config, save);
        return true;
      }
      const prefix = `/repos/${release.repository}`;
      if (!state.dispatchAttempted) {
        const ref = await this.api.request(`${prefix}/git/ref/heads/${state.branch}`);
        if (ref.object?.sha !== state.publishedSha) throw new AppError(409, 'DELIVERY_BRANCH_CONFLICT', 'Published branch moved before release dispatch');
        save({ ...state, dispatchAttempted: true }); // persist BEFORE external event; uncertain dispatch is discovered, never replayed
        const dispatched = await this.api.request(`${prefix}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`, 'POST', { ref: state.branch, inputs: { release_id: release.id, source_sha: state.publishedSha } });
        if (Number.isSafeInteger(dispatched?.workflow_run_id)) save({ ...state, workflowRunId: dispatched.workflow_run_id });
        return true;
      }
      let workflow;
      if (state.workflowRunId) workflow = await this.api.request(`${prefix}/actions/runs/${state.workflowRunId}`);
      else {
        const listing = await this.api.request(`${prefix}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?head_sha=${state.publishedSha}&event=workflow_dispatch&per_page=100`);
        const matches = (listing.workflow_runs ?? []).filter(run => run.head_sha === state.publishedSha && run.head_branch === state.branch && run.event === 'workflow_dispatch' && run.display_title === `delivery-${release.id}`);
        if (matches.length > 1) throw new AppError(409, 'AMBIGUOUS_WORKFLOW', 'Multiple release pipelines matched this operation');
        workflow = matches[0];
      }
      if (!workflow) { save(state); return true; }
      if (!Number.isSafeInteger(workflow.id) || workflow.head_sha !== state.publishedSha || workflow.head_branch !== state.branch || workflow.event !== 'workflow_dispatch' || workflow.display_title !== `delivery-${release.id}`) throw new AppError(409, 'WORKFLOW_COMMIT_MISMATCH', 'Pipeline is not bound to this exact published commit and release');
      state = { ...state, workflowRunId: workflow.id, workflowUrl: workflow.html_url };
      if (workflow.status !== 'completed') { save(state); return true; }
      if (workflow.conclusion !== 'success') throw new AppError(409, 'RELEASE_PIPELINE_FAILED', 'Release pipeline did not succeed');
      const deployments = await this.api.request(`${prefix}/deployments?sha=${state.publishedSha}&environment=${encodeURIComponent(config.environment)}&per_page=100`);
      const matches = (Array.isArray(deployments) ? deployments : []).filter(deployment => {
        let payload = deployment.payload; if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return false; } }
        return deployment.sha === state.publishedSha && deployment.environment === config.environment && payload?.delivery_release_id === release.id && payload?.workflow_run_id === workflow.id;
      });
      if (matches.length > 1) throw new AppError(409, 'AMBIGUOUS_DEPLOYMENT', 'Multiple deployment records matched this release');
      const deployment = matches[0];
      if (!deployment) { save(state); return true; }
      const statuses = await this.api.request(`${prefix}/deployments/${deployment.id}/statuses?per_page=100`);
      const status = Array.isArray(statuses) ? statuses[0] : null;
      if (!status || ['pending', 'queued', 'in_progress', 'waiting'].includes(status.state)) { save(state); return true; }
      if (status.state !== 'success') throw new AppError(409, 'DEPLOYMENT_FAILED', 'Latest deployment status is not successful');
      const deployed = new URL(status.environment_url);
      if (deployed.protocol !== 'https:' || deployed.username || deployed.password || !config.allowedDeploymentOrigins.includes(deployed.origin)) throw new AppError(409, 'DEPLOYMENT_ORIGIN_NOT_ALLOWED', 'Deployment URL is outside the configured HTTPS origins');
      const smokePath = config.smokePath ?? '/.well-known/delivery.json';
      if (typeof smokePath !== 'string' || !smokePath.startsWith('/') || smokePath.startsWith('//') || smokePath.includes('?') || smokePath.includes('#')) throw new AppError(503, 'RELEASE_POLICY_MISSING', 'Configure a same-origin smoke path');
      const smokeUrl = new URL(smokePath, deployed.origin);
      if (smokeUrl.origin !== deployed.origin) throw new AppError(409, 'DEPLOYMENT_ORIGIN_NOT_ALLOWED', 'Smoke URL must remain on the deployment origin');
      const response = await this.fetch(smokeUrl, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
      if (!response.ok) throw new AppError(409, 'SMOKE_FAILED', 'Deployed app smoke endpoint failed');
      const text = await response.text(); if (text.length > 65536) throw new AppError(409, 'SMOKE_FAILED', 'Smoke response exceeded limit');
      let marker; try { marker = JSON.parse(text); } catch { throw new AppError(409, 'SMOKE_FAILED', 'Smoke endpoint must return release metadata'); }
      if (marker.commitSha !== state.publishedSha || marker.releaseId !== release.id) throw new AppError(409, 'DEPLOYED_VERSION_MISMATCH', 'Live app does not match the published commit and release ID');
      state = { ...state, deploymentId: deployment.id, deploymentStatusUrl: status.url, smokeUrl: smokeUrl.toString(), smoke: marker };
      const evidenceUrl = `${this.publicUrl}/releases/${release.id}/evidence`;
      this.store.complete(release.id, { evidenceUrl, smokeEvidenceUrl: evidenceUrl, publishedCommitSha: state.publishedSha, pullRequestUrl: state.pullRequestUrl, workflowUrl: state.workflowUrl, deployedUrl: deployed.toString(), smokePassed: true }, state);
    } catch (error) {
      if (error.code === 'GITHUB_RELEASE_UNAVAILABLE') this.store.transientFailure(release.id);
      else this.store.fail(release.id, error instanceof AppError ? error.code : 'RELEASE_FAILED');
    } finally { this.busy = false; }
    return true;
  }
}
