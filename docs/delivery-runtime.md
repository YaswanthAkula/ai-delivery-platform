# Delivery manager and worker

## Implemented status

Implemented: durable SQLite delivery runs/jobs, model-backed task decomposition, mandatory stage gates, dependency scheduling, leased background workers, checkpoint recovery, bounded dispatch/retry counts and an authenticated HTTP adapter for a separate coding runtime.

The coding runtime server is implemented (docs/codex-runtime.md): allowlisted source repositories, separate Git clones/branches, Codex CLI invocation, evidence and trusted acceptance commands. A separate GitHub/CI release service is also implemented (docs/github-release.md). Codex authentication, hosting/provider workflows and credentials remain unconfigured; browser-specific QA and automatic remediation remain unimplemented. The HTTP protocol below is our integration contract, not an OpenAI endpoint. Tests exercise real services and temporary Git repositories with injected Codex/GitHub/provider responses; live model execution/deployment has not been verified.

## Start and observe delivery

After approving a specification, POST `/projects/:id/delivery` with:

```json
{ "repository": "owner/application-repo", "maxAttempts": 3, "maxDispatches": 100 }
```

Repeated starts return the same run for that approved version; a different repository is rejected. The target repository is the application repository, not this platform repository. Approval and enqueue are currently separate API operations.

GET `/projects/:id/delivery` returns jobs, dependencies, attempts, errors, checkpoints and evidence. POST `/projects/:id/delivery/resume` with `{ "runId": "..." }` retries a blocked run after configuration/access issues are resolved. It does not reset execution limits. Timed-out remote operations require reconciliation; an admin reconciliation API is future work.

All endpoints use the planning backend bearer authentication. Set MANAGER_MODEL and OPENAI_API_KEY on the backend worker. Set CODING_RUNTIME_URL and CODING_RUNTIME_TOKEN to a trusted HTTPS runtime service, then run `npm run worker` in a supervised process separately from `npm start`.

Server and workers share the same persistent SQLite file at DATABASE_PATH on a single host/disk. Do not mount SQLite over a network filesystem or start independent replicas with separate disks. PostgreSQL is required before a distributed deployment.

## Scheduling and recovery

The manager proposes ordered implementation tasks with explicit dependencies and zero-based acceptance-criterion mappings. The platform rejects cycles/forward references, duplicate/reserved keys and missing criterion coverage. It inserts mandatory design, review, QA and release jobs around implementation.

Workers claim jobs with a 90-second lease and heartbeat every 20 seconds. There is one active job per run; different runs can be processed by separate workers sharing the same SQLite file. Only dependency-ready jobs can run. A new claim fences out stale workers. Expired jobs become eligible again.

Before submitting remote work, the worker persists an idempotency key. After submission it persists the operation ID. Recovery polls that operation instead of resubmitting it. A lost submission response is retried with the same key. The runtime MUST durably honor idempotency; otherwise duplicate external work is possible.

Polling does not consume new dispatch attempts. Failed submissions/polls have bounded retry counts; remote operations have a 30-minute persisted deadline. Provider manager failures block instead of being blindly retried, because a timed-out model call may already have incurred charges. Manager-call results are committed atomically with generated jobs, but a crash before saving the response may repeat a paid manager call.

Run dispatch/retry caps are not a token or monetary budget. Runtime token accounting, hard spending reservations and durable planning calls remain future work. Failed reviews/QA block downstream work. Automatic diagnosis/remediation loops are not yet implemented; retry only when the runtime explicitly reports a terminal failure as retryable.

## Coding runtime HTTP contract

Every request sends `Authorization: Bearer <CODING_RUNTIME_TOKEN>`. Only configure an operator-controlled endpoint. The runtime must authenticate requests, allowlist application repositories and provision isolated workspaces. It must not trust model text as test/deployment evidence. Run Codex and repository code in isolated workers; keep production credentials in release infrastructure, separate from coding tools.

POST `<CODING_RUNTIME_URL>/operations` includes `Idempotency-Key` and this body:

```json
{
  "runId": "uuid",
  "jobId": "uuid",
  "repository": "owner/application-repo",
  "specificationVersion": 1,
  "kind": "implementation",
  "payload": { "instructions": "...", "specification": {} },
  "dependencies": [{ "key": "__design", "kind": "design", "result": {} }]
}
```

Return `{ "id": "operation_identifier" }`. IDs contain 1–128 letters, numbers, underscores or hyphens. Repeating a request key must return the same operation; conflicting payloads for the same key must be rejected. The runtime owns workspace isolation, integrating predecessor commits, execution checkpoints and durable operation state.

GET `<CODING_RUNTIME_URL>/operations/:id` returns one of:

```json
{ "status": "running" }
```

```json
{ "status": "failed", "retryable": false }
```

```json
{ "status": "succeeded", "result": { "evidenceUrl": "https://runtime.example/evidence/job" } }
```

`queued` is also a valid pending status. Terminal failures must not secretly keep executing; the scheduler may start a new attempt when retryable is true.

Required result fields by kind:

| Kind | Required result evidence |
| --- | --- |
| design | evidenceUrl, designUrl |
| implementation | evidenceUrl, commitSha (40–64 hexadecimal characters), diffUrl |
| review | evidenceUrl, reviewPassed: true |
| qa | evidenceUrl, acceptanceResults: one passing item for every criterion index, each with evidenceUrl |
| release | evidenceUrl, deployedUrl, smokePassed: true, smokeEvidenceUrl |

Every URL must be HTTPS. Runtime evidence artifacts must be stored persistently, access controlled and derived from actual tools/CI. This initial adapter validates response shape; it does not independently verify or cryptographically attest remote evidence. Delivered status is trustworthy only to the extent the configured runtime is trustworthy.

## Next runtime implementation

Deploy/configure the implemented runtime and separate release service (docs/codex-runtime.md, docs/github-release.md). Verify live Codex/GitHub access, prepare a real provider workflow, then add automatic repair and browser tooling. Without release configuration the runtime returns RELEASE_ADAPTER_MISSING.

Official references:
- https://learn.chatgpt.com/docs/codex-sdk
- https://learn.chatgpt.com/docs/non-interactive-mode
