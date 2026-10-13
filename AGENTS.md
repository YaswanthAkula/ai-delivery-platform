# Delivery platform instructions
Build a reusable platform; keep generated customer applications in separate repositories.
Read docs/architecture.md before implementing runtime integrations.
Never claim an app is complete based on agent statements alone.
Require acceptance evidence, review results and post-deployment smoke checks.
Preserve approved requirements. Ask only for unresolved business decisions or missing access.
Keep secrets out of repository files, logs and chat. Use backend secret storage.
Use isolated task branches/workspaces; the manager owns integration.
Persist task state and checkpoints before retries or handoffs.
Set retry, concurrency and spending limits. Exhausted limits mean blocked, not done.
Do not implement hospital business logic inside this platform.
