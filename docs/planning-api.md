# Planning API

## Status and startup

Implemented: single-owner authenticated HTTP API, SQLite project memory, versioned drafts, explicit approval, Responses API planner adapter and token usage records.
Not implemented: public mobile UI/ChatGPT integration, delivery manager, workers, code execution or application deployment. Approval marks a project ready; it does not start coding yet.

Requires Node.js 24+. There are no npm dependencies. Set APP_AUTH_TOKEN (a random secret of at least 32 characters), OPENAI_API_KEY and PLANNER_MODEL in backend secrets. Do not paste secrets into chat or commit them. The model must support the Responses API and be available to the account; no model is silently substituted.

Run `npm start` with environment variables configured. For a local git-ignored .env file, `node --env-file=.env src/server.mjs` loads it explicitly. The server binds localhost by default. Health is public; every project endpoint requires `Authorization: Bearer <APP_AUTH_TOKEN>`. Deploy behind HTTPS before remote use. This shared-token authentication is an initial single-owner backend mechanism, not a browser login or multi-tenant authorization system.

The database lives at DATABASE_PATH. Mount a persistent disk and back it up. SQLite supports this single-server stage; migrate to PostgreSQL and distributed locks before multiple server replicas/workers. Conversation content is stored on disk; do not use real patient records for development.

## Endpoints

| Method | Path | Body / behavior |
| --- | --- | --- |
| GET | /health | Liveness only |
| POST | /projects | `{ "name": "Hospital", "idea": "Appointment coordination" }` |
| GET | /projects | List projects |
| GET | /projects/:id | Project, revision, specification versions and token totals |
| POST | /projects/:id/messages | `{ "content": "Receptionists book appointments" }`; invokes planner |
| GET | /projects/:id/messages | Successful planning transcript |
| POST | /projects/:id/specifications | Save an owner-edited draft with the schema below |
| GET | /projects/:id/specifications | Read all draft versions and approval timestamps |
| POST | /projects/:id/approve | `{ "version": 1, "expectedRevision": 1, "acknowledgeAssumptions": true }` |

Specification schema:

```json
{
  "title": "Appointment coordination",
  "goal": "Help receptionists confirm appointments",
  "users": ["Receptionist"],
  "inScope": ["Book an available appointment"],
  "outOfScope": ["Billing"],
  "acceptanceCriteria": ["A valid booking returns a confirmation ID"],
  "assumptions": [],
  "openQuestions": []
}
```

Approval requires the latest draft, the current project revision, no unresolved questions and explicit acknowledgement if assumptions exist. A conversation after a draft invalidates its approval eligibility until an updated draft is saved. Approved content is frozen; a future change-request feature will support amendments.

## Planner behavior and limits

The planner uses the official Responses endpoint with instructions, current project details, latest draft and successful conversation history. It has no research or execution tools. Responses are parsed and validated before saving; instructions do not guarantee factual accuracy. The owner reviews the actual specification before approval.

Missing model configuration returns 503; invalid or incomplete model output returns 502 and saves no transcript/draft. Successful provider usage is recorded even when parsing fails. Provider errors are sanitized and are not automatically retried.

Per-call output cap, 60-second model timeout, 64-KiB request cap, 60,000-character context limit and per-project successful-turn limit bound initial use. Context is not silently truncated. These are not a monetary budget guarantee: failed calls may still cost tokens, retries are not idempotent, and crashes during provider calls may lose usage records. Durable model jobs, idempotency, usage reservations, cost accounting and compaction are next-stage work. HTTP planning requests are synchronous and cannot yet be guaranteed to continue across server restarts.

Run `npm test`. Tests use injected model responses (no API spend); live provider access and deployment have not been verified.

Official reference: https://developers.openai.com/api/docs/guides/text
