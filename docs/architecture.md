# AI delivery platform
## Goal
Discuss an idea with the owner, freeze an approved specification, then execute design, implementation, review, testing and deployment. Support multiple projects with separate repositories and execution environments.

## Current status
The platform has a dependency-free Node.js planning API with SQLite project memory, a Responses API planner adapter, versioned drafts and explicit approval gates. Delivery runs support manager task decomposition, leased workers, dependency scheduling and remote checkpoints. The coding runtime service implements Codex CLI execution in separate Git clones/branches, design/coding/review artifacts and command-backed QA. Model authentication/cloud hosting are not configured; application deployment is not implemented. The TypeScript workflow demo remains illustrative. See docs/planning-api.md, docs/delivery-runtime.md and docs/codex-runtime.md for setup and limits.

## Roles
Planner: gather requirements, assumptions, exceptions and acceptance criteria.
Manager: schedule dependency-ready tasks, enforce budgets, persist progress and integrate changes.
Designer: create design system, screen specifications and interaction states.
Developer: implement scoped tasks in isolated environments.
Reviewer: inspect implementation against specification and report defects.
QA: execute acceptance checks in browser/API environments and attach evidence.
Release: deploy using configured credentials, run smoke checks and record delivery URL.

## Runtime design
Mobile chat -> authenticated backend -> project/specification storage -> durable execution queue -> manager -> specialist workers.
Initial single-server planning memory uses SQLite on a persistent disk. PostgreSQL is the target for specifications, tasks, approvals, checkpoints and usage records when distributed delivery workers are added.
A durable queue/worker must resume after process restart. Model conversations alone are not durable execution.
Evaluate OpenAI Agents SDK for orchestration and managed Agents API access for coding environments before choosing adapters.
GitHub adapter manages separate application repositories. Jira is optional; platform tasks remain authoritative.
Deployment runs through configured CI/CD. Do not give model-generated commands unrestricted production credentials.

## Gates
Planning -> ready: approved specification version and explicit acceptance criteria.
Building -> reviewing: implementation exists with changed-file evidence.
Reviewing -> testing: review passes.
Testing -> deploying: acceptance checks pass.
Deploying -> delivered: deployed URL and smoke checks pass.
Errors must be persisted with bounded retry counts. Missing access or exhausted budget blocks work.
Evidence must come from tools/CI; the workflow demo's booleans are illustrative, not trusted production checks.

## Next implementation
1. Deploy/configure the planning backend and verify live model access.
2. PostgreSQL migration, durable model jobs, idempotency and spending reservations.
3. Configure and verify manager model access; add automatic remediation and runtime usage accounting.
4. Deploy/configure the coding runtime service and add GitHub publishing/PR integration.
5. Design/review/browser QA tools.
6. CI/CD release adapter and mobile ChatGPT integration.
