# GitHub publishing and CI/CD release integration

## Implemented and unconfigured parts

Implemented: a separate authenticated release service, snapshot validation, GitHub Git-object publishing, delivery branch/PR creation, workflow dispatch, exact-commit pipeline verification, deployment-record verification, live version smoke checks and persisted release checkpoints.

No live application has been published/deployed through this service. GitHub credentials, HTTPS hosting, an application-specific trusted workflow and a hosting provider deployment step remain unconfigured. Tests mock GitHub/provider responses; runtime integration tests use real Git repos/commands. This adapter is infrastructure for executing a configured workflow, not a universal hosting provider.

## Service separation

Run the release service separately from the Codex/QA host. It never executes repository code or child commands. Only this service receives GITHUB_RELEASE_TOKEN. The coding runtime sends a verified Git snapshot and holds only the limited release-service API token. Do not mount the release service's environment/configuration into the coding container.

The runtime checks that a passing review and acceptance results exist for its exact current local commit before sending a release snapshot. The snapshot includes immutable source commit/tree SHAs, regular/executable file entries and changed blobs encoded as base64. Git blob hashes are validated. Supported initial limits: 2,000 files, 4 MB per changed blob, 8 MB total changed blobs; symlinks/submodules need future support.

## GitHub behavior

The configured base branch must still equal the source base commit. The service uploads changed Git blobs, creates the full tree and requires the returned tree SHA to match the tested local source tree. It creates a publication commit with deterministic metadata, then creates `delivery/<run-id>` and a PR targeting the configured base branch.

It does not move/merge main, force-update an existing delivery branch or automatically resolve base drift. A conflicting branch or moved base blocks release. The publication commit can have a different SHA from the local generated commit; its tree must be identical. Both provenance SHAs are recorded.

The trusted workflow's blob SHA must match operator configuration. Generated changes cannot alter any `.github/` file, including workflows/actions. Configure the workflow before starting an application run and refresh its pin only through the operator-controlled setup process.

## One-time application workflow contract

Create a real provider-specific `delivery.yml` workflow on the application's base branch. It must be available for workflow_dispatch and accept these string inputs:

```yaml
name: Application delivery
run-name: delivery-${{ inputs.release_id }}
on:
  workflow_dispatch:
    inputs:
      release_id:
        required: true
        type: string
      source_sha:
        required: true
        type: string
```

This is a trigger fragment, NOT a complete runnable deployment workflow. Add genuine build, tests and provider deployment jobs. The workflow must check out and verify `inputs.source_sha == github.sha`; the service dispatches the generated branch and verifies that exact SHA later. Use reviewed/pinned actions and keep hosting credentials in a separate deployment job/environment. Do not execute generated application scripts in a job holding production credentials.

The build/deploy process must serve a same-origin JSON version marker, normally `/.well-known/delivery.json`:

```json
{ "commitSha": "the-published-github-commit-sha", "releaseId": "the-dispatched-release-id" }
```

Inject these values from the workflow's verified source SHA and release_id, not from agent-authored assertions.

After a real provider deployment, the trusted workflow must create a GitHub deployment with:

- ref/sha: the verified published commit;
- environment: the configured environment (e.g. preview);
- payload: `{ "delivery_release_id": "...", "workflow_run_id": 123 }`, with workflow_run_id stored as a number;
- successful deployment status with the actual HTTPS environment_url.

Do not publish a successful deployment status before the provider finishes. Configure allowedDeploymentOrigins to match actual provider origins. The adapter requires both pipeline success and a correlated deployment status, then fetches the live marker without credentials. A generic HTTP 200 or an old app version cannot satisfy delivery.

## Configure and start

Create operator configuration from `release-repositories.example.json`; replace every placeholder. `workflowBlobSha` is the Git blob SHA of `.github/workflows/delivery.yml`, not its commit SHA. Register only authorized application repositories. Keep the configuration file outside the generated application workspace.

| Release-host variable | Purpose |
| --- | --- |
| RELEASE_SERVICE_TOKEN | Random shared secret, at least 32 characters |
| GITHUB_RELEASE_TOKEN | GitHub App installation or fine-grained token for allowlisted repositories |
| RELEASE_REPOSITORIES_FILE | Absolute operator configuration JSON path |
| RELEASE_PUBLIC_URL | Authenticated HTTPS service base URL |
| RELEASE_DATABASE_PATH | Persistent SQLite path; default ./release-data/releases.sqlite |
| RELEASE_HOST / RELEASE_PORT | Default listener 127.0.0.1:3200 |

GitHub permissions needed by this adapter: Contents write, Pull requests write, Actions write and Deployments read. Workflow deployment jobs separately need whatever the hosting provider/GitHub deployment-status API requires. Never paste tokens into chat or source files. Rotate installation tokens via hosting secret management; automatic token minting/refresh is not implemented.

Run `npm run release` behind HTTPS. One supervised service process owns each database lock. Configure RELEASE_SERVICE_URL and RELEASE_SERVICE_TOKEN on the coding runtime; the release URL should point to this service. Do not put GITHUB_RELEASE_TOKEN on the coding runtime or planner.

## APIs and evidence

All release/evidence endpoints require the release bearer token. Public GET /health is liveness only.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | /releases | Git snapshot; requires Idempotency-Key; returns release ID |
| GET | /releases/:id | Queued/running/succeeded/failed and result/error |
| GET | /releases/:id/evidence | Source provenance, published commit/PR, pipeline/deployment/smoke evidence |

One immutable snapshot is accepted per application run. Duplicate keys/same snapshots return the existing operation; conflicts are rejected. Shared-token authentication is initial single-owner service authentication, not multi-tenant identity.

## Recovery and limits

Publishing operations are content-addressed/checkpointed. Existing branches/PRs are queried before creating another. Dispatch intent is persisted BEFORE sending a workflow event. A lost dispatch response is discovered by exact commit, branch, workflow event and `delivery-<release-id>` run title; the service never blindly re-dispatches. Ambiguous pipelines/deployments block. Missing pipeline records remain pending until the 30-minute deadline.

Release-service restart resumes its saved state. Runtime restart can resume a checkpointed release using the same remote ID/key; interrupted coding operations still require reconciliation. Provider/network errors, permissions failures or pending environment approvals can block a release. The service does not approve protected-environment requests or bypass branch/CI controls. Failed/timed-out releases require reconciliation; an operator resume API and automatic repair are future work.

Smoke checks are limited to configured HTTPS origins and refuse redirects. Releases are not auto-merged into main. A configured workflow may deploy a preview directly from the delivery branch. Production rollout policy is part of one-time workflow configuration.

Official references:
- https://docs.github.com/en/rest/git/trees
- https://docs.github.com/en/rest/actions/workflows
- https://docs.github.com/en/rest/actions/workflow-runs
- https://docs.github.com/en/rest/deployments/statuses
