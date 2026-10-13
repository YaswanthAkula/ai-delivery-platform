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

## Run

Node.js 24+ required; no dependencies to install.

```bash
npm test
npm start
npm run worker
```

Configure backend environment variables before starting; see [.env.example](.env.example) and [planning API documentation](docs/planning-api.md). Never commit credentials. The default listener is localhost. Remote deployment requires HTTPS and persistent storage.

## Current limits

This is the planning and delivery orchestration backend, not the complete autonomous delivery team. The coding runtime service, actual design/review/browser QA execution, deployment adapters and mobile ChatGPT connection remain to be implemented. Approving a specification marks it ready; a separate delivery API call queues work. No live model call, coding session or cloud deployment has been verified. See [delivery/runtime contract](docs/delivery-runtime.md) for worker setup, endpoints, evidence gates and remaining work.

Use [architecture](docs/architecture.md) and [agent instructions](AGENTS.md) for implementation rules. `npm run demo` runs a simulated TypeScript workflow with illustrative evidence only.

Customer application code, including hospital-saas, belongs in separate repositories.
