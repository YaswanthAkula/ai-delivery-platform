# AI delivery platform
## Goal
Discuss an idea with the owner, freeze an approved specification, then execute design, implementation, review, testing and deployment. Support multiple projects with separate repositories and execution environments.

## Current status
This commit is a dependency-free TypeScript foundation with a local workflow demonstration. It does not call models, run background jobs, connect Jira/GitHub, or deploy applications.

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
Use PostgreSQL for specifications, tasks, approvals, checkpoints and usage records.
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
1. Backend authentication and project/specification APIs.
2. PostgreSQL persistence and durable jobs.
3. Planner/manager model integration with usage accounting.
4. Isolated coding worker and GitHub adapter.
5. Design/review/browser QA tools.
6. CI/CD release adapter and mobile ChatGPT integration.
