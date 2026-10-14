# AI Delivery Platform

Reusable agent platform: discuss an idea, approve requirements, then build toward autonomous design, coding, testing and deployment across separate application repositories.

## Implemented

- Authenticated single-owner planning HTTP API.
- Persistent project/conversation memory using SQLite.
- OpenAI Responses API planner adapter (requires backend API credentials and model configuration).
- Versioned specification drafts, unresolved-question checks and explicit approval.
- Token usage tracking, bounded output and planning-turn limits.
- Integration tests for persistence, authentication, model failures and approval safeguards.
- Model-backed manager task decomposition and durable delivery runs/jobs.
- Dependency scheduling, worker leases, restart checkpoints and dispatch/retry limits.
- Authenticated connector for a separate coding-runtime service.
- Authenticated runtime service with separate application Git clones/branches and a Codex CLI executor.
- Persisted code/design/review artifacts and command-backed acceptance-check evidence.
- Separate trusted GitHub/CI release service: exact-tree publishing, delivery branches/PRs and persisted workflow dispatch.
- Exact-commit pipeline/deployment checks and live version smoke verification.

## Run

Node.js 24+ required; no dependencies to install.

```bash
npm test
npm start
npm run worker
npm run runtime
npm run release
```

Configure backend environment variables before starting; see [.env.example](.env.example) and [planning API documentation](docs/planning-api.md). Never commit credentials. The default listener is localhost. Remote deployment requires HTTPS and persistent storage.

## Current limits

This is the planning, orchestration, execution and release backend, not a deployed autonomous delivery team. Codex/model authentication, cloud hosting, GitHub release credentials and application/provider workflows are not configured. Automatic repair, browser-specific QA and mobile ChatGPT connection remain to be added. Approval marks a project ready; a separate delivery API call queues work. Tests use real Git repositories/commands with injected Codex/GitHub/provider responses; no live model call or deployment has been verified. See [delivery contract](docs/delivery-runtime.md), [Codex runtime setup](docs/codex-runtime.md) and [GitHub/CI release setup](docs/github-release.md).

Use [architecture](docs/architecture.md) and [agent instructions](AGENTS.md) for implementation rules. `npm run demo` runs a simulated TypeScript workflow with illustrative evidence only.

Customer application code, including hospital-saas, belongs in separate repositories.
