# Codex execution service

## What is implemented

The runtime server implements the existing delivery-runtime HTTP contract. It stores operation IDs/idempotency keys in SQLite, authenticates requests, allowlists application repositories, provisions a separate Git clone/branch per delivery run, invokes Codex non-interactively and saves evidence artifacts in the database.

Design jobs require a committed `.delivery/design.md` screen specification. Implementation jobs produce real local commits and integrated diffs. Review jobs run Codex read-only and record its findings. QA jobs execute operator-configured commands and record actual exit codes/output for each exact approved acceptance criterion. A review agent's opinion is not a substitute for acceptance tests.

Release returns RELEASE_ADAPTER_MISSING: no deployment is attempted. CI/CD deployment, browser-specific tooling, automatic repair loops, GitHub publishing/PRs and a mobile UI remain to be added. Local design Markdown is a design specification, not proof of attractive rendered screens.

## Configure on a cloud runtime host

Requires Node.js 24+, Git and a compatible installed Codex CLI. No npm dependencies are needed for the platform code. Configure Codex authentication/model access on the isolated runtime host through an approved credential proxy or protected CLI configuration. This service deliberately does not pass OPENAI_API_KEY/CODEX_API_KEY or backend tokens to child commands. Authentication setup is not performed by this code and has not been verified live.

Prepare a local application repository on that host, then create an operator-controlled repository configuration file using `runtime-repositories.example.json`. Set its absolute `path`, a base ref and reviewed acceptance-test argument arrays. This is server configuration, never a path/command supplied by the model or mobile caller. Each approved criterion must have a matching configured test. Automated generation/review of this mapping is future work; missing checks block QA.

Set these runtime environment variables in the service's secret/configuration settings:

| Variable | Purpose |
| --- | --- |
| CODING_RUNTIME_TOKEN | Random shared secret, at least 32 characters |
| RUNTIME_PUBLIC_URL | HTTPS origin/base URL routed to this service |
| RUNTIME_REPOSITORIES_FILE | Absolute path to operator repository configuration JSON |
| RUNTIME_DATABASE_PATH | Persistent SQLite path; default ./runtime-data/operations.sqlite |
| RUNTIME_WORKSPACE_ROOT | Persistent workspace directory |
| RUNTIME_HOST / RUNTIME_PORT | Listener; defaults 127.0.0.1:3100 |
| CODEX_EXECUTABLE | Installed executable path; default codex |
| CODING_MODEL | Optional account-accessible Codex model; otherwise CLI configured default |
| CODEX_HOME | Optional protected Codex configuration directory |

Run `npm run runtime` behind an authenticated HTTPS reverse proxy. Evidence endpoints require the same runtime bearer token; do not make code, diffs, traces or test output public. Configure CODING_RUNTIME_URL/token on the delivery worker to point to this service. RUNTIME_PUBLIC_URL should use the same base path as the reverse proxy route.

## Isolation and repository behavior

The runtime creates a separate clone with `--no-hardlinks` and branch `delivery/<run-id>`. All jobs within one run use the same integration workspace; operations are serialized. The source repository stays unchanged. Changes are local only; nothing is pushed to GitHub yet.

Git workspace separation is not an OS security boundary. Run this service in a dedicated, isolated Linux container/VM with a restricted filesystem/network and no production credentials. Git/test commands execute as that service user; acceptance commands are not sandboxed by Node. Never run it on a personal machine with sensitive files or share a runtime between untrusted tenants. Use separate release infrastructure for production credentials. The runtime needs access only to prepared application repositories, workspaces and protected Codex configuration.

Codex uses `--ask-for-approval never`, `workspace-write` for design/coding and `read-only` for review. This does not bypass sandbox restrictions. Tasks needing unavailable dependencies/network will block until the runtime image is prepared. Existing CLI configuration may enable tools; keep that configuration operator controlled.

Subprocesses use argument arrays with shell disabled. Their environment forwards only PATH, HOME, TMPDIR, LANG, LC_ALL and CODEX_HOME. API/runtime/backend secrets are not forwarded. Process groups are killed on timeout or excessive output. Limits: Git 2 minutes, acceptance check 5 minutes, Codex 20 minutes. Bound work through the manager's dispatch/retry caps; these are not a monetary budget guarantee.

## Persistence and interruption

Persist the runtime database AND workspace directory. One runtime process owns a database lock file. A second instance refuses startup. On graceful shutdown, it stops accepting work and waits for the current operation. Supervisors must terminate the entire process group/container on a forced shutdown.

A crash can leave uncertain filesystem/external effects. Before clearing a stale `.sqlite.lock`, verify the previous process group is fully stopped. Restart marks previously running operations EXECUTION_INTERRUPTED and does not replay them or claim they completed. Queued operations survive. Partial/unrecorded or dirty workspaces block subsequent execution and require reconciliation. Automatic Codex-session recovery/reconciliation is future work; do not reset or discard generated work blindly.

## Validation evidence

The test suite exercises real temporary Git repositories, separate branches/commits/diffs, actual command exit codes, authentication, idempotency, interrupted operation handling and subprocess failure limits. Codex outputs are injected in integration tests. A live Codex/model call and cloud deployment have not been run.

Official references:
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/developer-commands
