# AI Delivery Platform

Reusable agent platform: discuss an idea, approve requirements, then build toward autonomous design, coding, testing and deployment across separate application repositories.

## Implemented

- Authenticated single-owner planning HTTP API.
- Persistent project/conversation memory using SQLite.
- OpenAI Responses API planner adapter (requires backend API credentials and model configuration).
- Versioned specification drafts, unresolved-question checks and explicit approval.
- Token usage tracking, bounded output and planning-turn limits.
- Integration tests for persistence, authentication, model failures and approval safeguards.

## Run

Node.js 24+ required; no dependencies to install.

```bash
npm test
npm start
```

Configure backend environment variables before starting; see [.env.example](.env.example) and [planning API documentation](docs/planning-api.md). Never commit credentials. The default listener is localhost. Remote deployment requires HTTPS and persistent storage.

## Current limits

This is the planning backend, not the complete autonomous delivery team. The manager, durable workers, coding environments, design/review/QA agents, deployment adapters and mobile ChatGPT connection remain to be implemented. Approving a specification marks it ready and does not trigger delivery yet. No live model call or cloud deployment has been verified.

Use [architecture](docs/architecture.md) and [agent instructions](AGENTS.md) for implementation rules. `npm run demo` runs a simulated TypeScript workflow with illustrative evidence only.

Customer application code, including hospital-saas, belongs in separate repositories.
