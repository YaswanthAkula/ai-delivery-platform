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

## Run

Node.js 24+ required; no dependencies to install.

```bash
npm test
npm start
npm run worker
npm run runtime
```

Configure backend environment variables before starting; see [.env.example](.env.example) and [planning API documentation](docs/planning-api.md). Never commit credentials. The default listener is localhost. Remote deployment requires HTTPS and persistent storage.

## Current limits

This is the planning, orchestration and initial execution backend, not a deployed autonomous delivery team. Codex installation/authentication and cloud hosting are not configured. GitHub publishing, automatic repair, browser-specific QA, deployment adapters and mobile ChatGPT connection remain to be added. Approving a specification marks it ready; a separate delivery API call queues work. Tests use real temporary Git repositories and commands with injected Codex responses; no live model call or cloud deployment has been verified. See [delivery/runtime contract](docs/delivery-runtime.md) and [Codex runtime setup](docs/codex-runtime.md) for setup, evidence gates and remaining work.

Use [architecture](docs/architecture.md) and [agent instructions](AGENTS.md) for implementation rules. `npm run demo` runs a simulated TypeScript workflow with illustrative evidence only.

Customer application code, including hospital-saas, belongs in separate repositories.
