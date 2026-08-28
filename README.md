# AI Factory

A GitHub-native AI software factory. GitHub issues are the unit of work; a Master
agent dispatches **pipelines** — user-defined sequences of steps, each a full
agentic Claude Agent SDK session in an ephemeral Docker worker. Spec and locked
architecture live in [`spec files/`](spec%20files/) — build exactly that system.

**Backend first.** Every action is an API call; the operator uses curl until the
frontend phase.

## Layout

| Path | What |
|---|---|
| `docker-compose.yml` | `pg` + `inngest` (self-hosted) + `backend` on the `factory` network; `worker` build-only profile |
| `backend/` | API (public + internal planes), migrations, Inngest runner functions, Master service, provisioner |
| `worker/` | Ephemeral step-worker image (Claude Agent SDK + pinned CLI, canonical cwd `/work`) |
| `scripts/` | Operator scripts (worker AUTH_OK test) |

## Quickstart

```bash
docker compose up -d --build
```

Then check readiness (no auth required on `/health`):

```bash
curl -s http://localhost:3000/health
```

`ready` stays `false` — and the factory **refuses dispatch** — until every check
is green. Set the operator secrets:

```bash
curl -s -X PUT http://localhost:3000/settings/claude-token -H "content-type: application/json" -d '{"value":"<CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`>"}'
```

```bash
curl -s -X PUT http://localhost:3000/settings/github-token -H "content-type: application/json" -d '{"value":"<GitHub PAT with repo scope>"}'
```

```bash
curl -s -X PUT http://localhost:3000/settings/github-repo -H "content-type: application/json" -d '{"value":"owner/name"}'
```

Token rotation = re-PUT the setting. No restart.

Health checks reported: `postgres`, `inngest`, `claudeToken` (presence — real
validation is the worker auth test below), `githubToken` (validated live against
the GitHub API), `githubRepo`, `docker` (daemon socket, needed by the provisioner).

The Inngest dashboard is at http://localhost:8288.

### Worker AUTH_OK test (substrate validation gate)

Builds nothing new; runs one trivial turn inside the worker image against your
subscription OAuth token:

```bash
CLAUDE_CODE_OAUTH_TOKEN=<token> ./scripts/worker-auth-test.sh
```

(Windows: `.\scripts\worker-auth-test.ps1 -Token <token>`.)

Exit 0 prints `AUTH_OK` with a nonzero cost. Exit 2 = auth failure — note this
is detected **in-band** (the CLI reports "Not logged in" as a *successful* $0
result), which is exactly how the factory routes worker auth failures to a
factory-health notification instead of a step retry.

### Operator auth

Set `OPERATOR_TOKEN` in `.env` to require `Authorization: Bearer <token>` on the
public plane (everything except `/health`, `/api/inngest`, `/hooks/*`,
`/internal/*` — those have their own auth). Empty = no auth, local dev only.

## Build phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Skeleton: compose, migrations, settings + health, worker image + AUTH_OK test | **done** (real-token gate pending operator credentials) |
| 1 | Runner core: Inngest `runPipeline`, provisioner, step workers, contract validation, `retryWithFeedback` | **done** — all gates passed live 2026-08-28 (real E2E run with PR, forced reject×2 then fail, fresh re-clone, worker self-timeout + runner timeout backstop, artifact contract, streaming logs) |
| 2 | Master agent: SDK sessions, in-process MCP tools, chat mirror, IssueCache sync | **done** — all gates passed live 2026-08-28 (chat dispatch, blocked + already_running structured refusals, fresh-chat status, mirror-only history) |
| 3 | Human-in-the-loop: `ask_human` suspend/resume, `implement-gated` | not started |
| 4 | Triggers, notifications, `/events` SSE, idempotency | not started |
| 5 | Frontend (`web` service) | not started |

## Design notes (implementation choices within the spec)

- **Steps are stored as a jsonb array** on `pipeline_definitions` — pipelines
  are data, read whole, never queried per-step.
- **Runs snapshot their definition** (`pipeline_runs.definition_snapshot`) at
  spawn, so editing a pipeline never changes an in-flight run.
- `created_by` includes `api` (curl/CLI is a first-class door, per the API doc).
- Notification events include `factory-health` for substrate problems (worker
  auth failure), per the expanded architecture.
- `step_logs` inserts fire `pg_notify('step_logs', …)` for the live viewer.
- Inngest is pinned to the **v3 LTS** SDK line; the self-hosted server syncs
  the backend's functions at `http://backend:3000/api/inngest`.
- The runner waits on `step.finished` only in Phase 1; Phase 3 adds the race
  with `step.waiting_human` (workers currently never emit it).
- Worker sessions run with `permissionMode: 'dontAsk'` + the step's
  `allowedTools` — default deny, no bypassPermissions anywhere. The agent's
  tool env is stripped to HOME/PATH/CLAUDE_CODE_OAUTH_TOKEN (git push auth is
  embedded in the remote URL, the internal token never enters the session).
- Step verdicts ride the SDK's `outputFormat: json_schema` structured output,
  with a \`\`\`verdict fence parse as fallback; the runner still checks the
  declared artifact exists on the branch.
- **Issue dependencies**: declare blockers in the issue body with a line like
  `Blocked-by: #1, #2`. Satisfaction is computed in code (a blocker counts as
  satisfied when its issue is completed/closed); the Master and `POST /runs`
  refuse to dispatch blocked issues unless `force` is set.
- **Master chat**: `POST /chats` → `POST /chats/:id/messages {"message": "…"}`
  streams the turn as SSE (`assistant`, `tool.use`, `done`, `error` events).
  History (`GET /chats/:id/messages`) renders purely from the DB mirror.
  Master sessions live under the session-store volume (`/data/sessions`) so
  conversations survive backend restarts; built-in tools are stripped — the
  Master acts only through the factory MCP tools.
