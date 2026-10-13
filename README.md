# AI Delivery Platform

Reusable agent delivery platform: discuss an idea, approve requirements, then execute design, coding, review, testing and deployment across separate application repositories.

## Current status

Initial foundation only. No model calls, background workers, GitHub/Jira runtime integrations or deployment adapters are implemented yet. The workflow demo uses simulated evidence and does not build or deploy an application.

## Files

- `AGENTS.md`: implementation and delivery rules.
- `docs/architecture.md`: roles, durable execution design, quality gates and roadmap.
- `src/workflow.ts`: pure TypeScript workflow demonstration.
- `src/demo.ts`: runnable example.

## Run the demonstration

Requires Node.js 24 or newer. No dependencies or API credentials are required.

```bash
npm run demo
```

The command prints simulated stages from planning through delivery. It is a demonstration, not a production agent runtime.

## Next work

Build authenticated backend and project/specification storage; durable workers and checkpoints; planner/manager model integration and usage limits; isolated coding environments and repository tools; design/review/QA integration; deployment adapters and mobile entry point.

Application code, including hospital-saas, belongs in its own repository. Keep credentials in backend secret storage, never in source files.
