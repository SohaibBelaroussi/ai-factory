# AI Factory — Implementation Record

Status as of 2026-08-28: **All phases (0–5) complete and gated live. The
backend is hardened; the frontend (Phase 5) shipped and passed the spec's
done-when gate.**
This document is the authoritative record of what exists and how it works —
written for a fresh context to continue the build without archaeology. The
product spec lives in [`spec files/`](../spec%20files/); this file records how
it was realized and where reality deviated (deliberately) from it.

---

## 1. Topology

`docker compose up -d --build` from repo root brings up, on the Docker network
`factory` (fixed name):

| Service | Image | Role |
|---|---|---|
| `pg` | postgres:16-alpine | Status DB, step logs, chat mirror, artifact archive. Volume `pgdata`. |
| `inngest` | inngest/inngest (self-hosted, `inngest start`) | Durable runner engine. SQLite on volume `inngest-data`. Dashboard :8288. **Signing key must be BARE hex** (rejects `signkey-` prefix); event key any string; compose has working local defaults, override via `.env`. |
| `backend` | built from `backend/` | Public + internal API planes, Inngest runner functions, Master service, provisioner. Port :3000. Mounts `/var/run/docker.sock` (provisioner) and volume `session-store` at `/data/sessions`. |
| `worker` | built from `worker/`, tag `ai-factory-worker:latest` | **Build-only compose profile `tools`** — not a running service. The provisioner spawns instances per step; `docker compose --profile tools run --rm worker` runs the AUTH_OK substrate test. |
| `web` | built from `web/` (Vite static build → nginx:alpine) | The frontend. Port :8080. nginx serves the SPA and proxies `/api/*` → `backend:3000` (prefix stripped, `proxy_buffering off` for SSE) — one origin, no CORS. Talks ONLY to the public API. |

Backend and worker are TypeScript/Node 22, tsc-compiled, multi-stage
Dockerfiles. Key pinned deps: `inngest 3.54.2` (v3 LTS — do NOT bump to v4),
`fastify 5.12.1`, `pg 8.23.0`, `dockerode 5.0.1`, `zod ^4` (root; inngest keeps
a nested zod 3), `@anthropic-ai/claude-agent-sdk 0.3.247` **exact** in both
backend (Master) and worker.

## 2. Repo layout

```
backend/
  migrations/            001_domain.sql (full §4 model) · 002_run_artifacts.sql · 003_events.sql (pg_notify triggers)
  src/
    config.ts            env config (DATABASE_URL, INNGEST_*, OPERATOR_TOKEN, SESSION_STORE_DIR,
                         WORKER_IMAGE, DOCKER_NETWORK, INTERNAL_API_URL, MASTER_MODEL)
    index.ts             boot: waitForDb → migrate → seedPipelines → startEventListener → listen
    db/                  pg pool + minimal forward-only migration runner (schema_migrations, advisory lock)
    domain/types.ts      StepDefinition/PipelineDefinition/Verdict/RunCtx/EVT event names/VERDICT_SCHEMA/parseVerdict
    http/server.ts       Fastify; bearer auth hook (skips /health, /api/inngest, /hooks/*, /internal/*)
    http/routes/         health · settings · pipelines · runs · internal · chats · board · questions ·
                         notifications · events (SSE) · hooks (webhook receiver + triggers CRUD)
    inngest/client.ts    Inngest client (id 'ai-factory')
    inngest/functions.ts runPipeline · factory-ping · factory-cron-tick (all served at /api/inngest)
    master/prompt.ts     Master system prompt (incl. the re-read-every-turn staleness rule)
    master/tools.ts      in-process MCP server 'factory' (10 tools) + FACTORY_TOOL_NAMES
    master/service.ts    runMasterTurn: session resume, chat mirroring, SSE event callback
    modules/
      commands.ts        spawnRun · cancelRun · answerQuestion (+ RefusalError = structured refusals)
      runnerOps.ts       loadRun · prepareRun · provisionStep · finalizeStep · suspendStepCleanup ·
                         resumeStep · failRun · completeRun (PR creation lives here)
      provisioner.ts     dockerode: startWorker/killWorker/removeWorker (+container-log capture into step_logs)
      github.ts          REST adapter: branches, contents (put/read/delete), issues, comments, labels, ensurePullRequest
      issueSync.ts       GitHub→issue_cache projection; parseBlockedBy ("Blocked-by: #N" in issue body);
                         60s staleness guard (syncIssuesIfStale)
      projections.ts     getBoard · listRuns · getIssueDetail (dependency satisfaction computed) · listOpenQuestions
      pipelines.ts       CRUD + validateSteps + seeds (implement, implement-gated)
      prompts.ts         HARNESS_PROMPT (layer 1) + buildRuntimeContext (layer 3)
      artifacts.ts       readRunArtifact (archive-first, branch fallback) · archiveRunArtifacts
      sessionStore.ts    step-suspension JSONL paths + terminal-state deletion
      triggers.ts        createTrigger · verifySignature (HMAC) · fireWebhook (mapping) · fireDueSchedules (cron)
      events.ts          pg LISTEN (factory_events, step_logs) → in-process emitter for SSE routes
      notify.ts          notification-row adapter (v1 in-app; external channels = new callers here only)
      health.ts          6 checks + assertReady()/NotReadyError (gates every dispatch)
      settings.ts        keys: claude-oauth-token · github-token · github-repo (masked reads)
      cli.ts             pins the SDK's native claude binary path (Master sessions)
worker/
  src/
    main.ts              WORKER_MODE dispatch: auth-check | step
    authCheck.ts         AUTH_OK substrate test (exit 0 ok / 2 auth-fail / 1 indeterminate)
    authDetect.ts        auth-failure text patterns (in-band $0 "Not logged in" AND thrown 401 stream error)
    step.ts              full step lifecycle incl. suspend/resume (see §5)
    askHuman.ts          in-process MCP tool ask_human (files question via internal API, arms suspend)
    gitOps.ts            clone into /work, safety-net commit+push, rev-list commit attribution
    internalApi.ts       batched log streaming, cost, session upload/download, ONE-event emit w/ retries
    cli.ts               native claude binary resolution (env override → sibling pkg → fixed paths)
web/
  Dockerfile · nginx.conf  static build + /api reverse proxy (SSE-safe)
  vite.config.ts           dev proxy /api → localhost:3000 (same prefix contract as nginx)
  src/
    lib/api.ts             typed client for the whole public surface; operator bearer token
                           from localStorage; Refusal (409) thrown as data
    lib/sse.ts             SSE-over-fetch (chat turns are SSE on POST; EventSource can't
                           send auth headers) + persistentSse (backoff reconnect)
    lib/events.tsx         /events bus → TanStack Query invalidation (ids only → re-fetch)
    lib/types.ts           wire-faithful API types (camelCase projections AND snake_case rows)
    components/            ui primitives · DispatchDialog · QuestionCard · LogViewer · NotificationBell
    pages/                 Board · Runs · RunDetail · IssueDetail · Chat · Pipelines ·
                           PipelineEditor · Questions · Settings
scripts/                 worker-auth-test.ps1 / .sh
docker-compose.yml · .env.example · README.md (phase table, runbooks, design notes)
```

## 3. Domain model notes (vs spec §4)

Migration 001 creates the full model. Deviations/additions, all deliberate:

- `pipeline_definitions.steps` is a **jsonb array** (definitions are read whole).
- `pipeline_runs.definition_snapshot` — frozen at spawn; the runner executes
  the snapshot, so editing a pipeline never changes in-flight runs.
- `created_by` includes `'api'` (curl is a first-class door).
- `notifications.event` includes `'factory-health'` (worker auth failure → notification, never a retry).
- `step_runs` extras: `attempt` (unique with run+index), `internal_token_hash`
  + expiry (scoped worker tokens, sha256, nulled at terminal state),
  `container_id`, per-step `cost_usd` (accumulates across suspend/resume slices).
- `run_artifacts` (002): archived pipeline/ files per run (see §7).
- `trigger_fires` uses a **partial unique index** (trigger_id, delivery_id
  where not null) — inserts must use `on conflict (...) where delivery_id is
  not null` (plain column-list ON CONFLICT fails on partial indexes).
- 003 adds `notify_factory_event()` triggers → pg_notify('factory_events')
  on notifications/questions/pipeline_runs/step_runs/issue_cache changes;
  step_logs inserts notify 'step_logs' (001).

## 4. Runner (Inngest `runPipeline`)

Trigger `pipeline.run.requested {runId}`. Strictly linear; all state via
`step.run` closures in `runnerOps` (returns are Jsonify'd — hence `RunCtx`,
the run row minus Date fields). Per step index i, attempt a:

1. `provision-s{i}-a{a}` → step_run row (upsert on run+index+attempt for
   Inngest retry idempotency), scoped token minted, layer-3 context built,
   container `factory-step-<stepRunId>` started.
2. `wait-s{i}-a{a}` → `waitForEvent('step.finished', if stepRunId matches,
   timeout timeoutMinutes+3m)`.
3. **Suspend loop** (r = 1..): if the event's `outcome == 'waiting_human'`:
   `suspend-…` removes the container corpse; `answer-…` waits for
   `question.answered` (matched on questionId, timeout '30d'); `resume-…`
   starts a fresh worker with a NEW token, restored session, answer as the
   next message; then another `wait-…-r{r}`. Multi-turn ask cycles are just
   more iterations. 30d unanswered → treated like timeout.
4. `finalize-s{i}-a{a}` → contract validation IN CODE: verdict parses
   (parseVerdict) AND declared artifact exists on the branch (GitHub API,
   3×2s retries). Timeout (null event) → kill + capture container logs into
   step_logs + fail. Persists verdict/commit shas/session id; removes
   container; deletes any stored suspension session.
5. Routing: verdict `done` → next; `reject` → re-run PREVIOUS step with
   feedback (`rejections[prev] < retryWithFeedback`), else run fails;
   `failed`/contract-fail → run fails.
6. `completeRun`: archive artifacts → delete them from branch → **open PR**
   (ensurePullRequest; reuse open PR for the branch; base = default branch;
   body: brief + per-attempt verdicts + `Closes #N`) → board `needs-review`
   + linked_pr → ONE run-completed notification (with PR URL). `failRun`:
   archive (branch keeps files for debugging), notification (+factory-health
   if authFailure). Costs summed onto the run either way.
- `cancelOn: pipeline.run.cancelled` (match data.runId); `onFailure` marks
  the run failed so nothing dangles; function `retries: 2`.
- **Event-name deviation**: workers emit exactly ONE `step.finished` per exit
  with `outcome: done|failed|waiting_human|cancelled` — the catalog's
  `step.waiting_human` rides as an outcome, keeping waits linear and
  replay-deterministic. `pipeline.run.completed/failed` are emitted for the
  record; nothing consumes them yet.
- `cancelRun` (command): kills live containers, fails their steps, closes
  open questions ('(run cancelled)'), emits the cancel event.

## 5. Worker (step mode)

Env: `WORKER_MODE=step`, `STEP_CONTEXT` (JSON: ids, branch, repo, the three
prompt layers, allowedTools, model, outputArtifact, timeoutMinutes,
askHumanCap, attempt, resumeSessionId?, resumePrompt?), plus secrets
`CLAUDE_CODE_OAUTH_TOKEN`, `GIT_TOKEN`, `INTERNAL_TOKEN`, and URLs
`INTERNAL_API_URL`, `INNGEST_EVENT_URL`.

Lifecycle: clone branch into canonical `/work` (git auth via token embedded in
remote URL) → if resuming, GET session JSONL from internal API and write to
`$HOME/.claude/projects/-work/<sessionId>.jsonl` (cwd-keyed; **same session id
resumes**) → SDK `query()`:

- `systemPrompt: [harnessPrompt, behaviorPrompt]` (layers 1+2, stable prefix);
  the message is layer 3 (runtime context) or, on resume, the human's answer.
- `allowedTools` verbatim minus `ask_human` (which becomes MCP tool
  `mcp__factory__ask_human` when granted); `permissionMode: 'dontAsk'`
  (default deny, no prompts, bypassPermissions banned).
- `outputFormat: {type:'json_schema', schema: VERDICT_SCHEMA}` → verdict from
  `result.structured_output` (```verdict fence parse as fallback).
- `pathToClaudeCodeExecutable` pinned (SDK 0.3.x ships the CLI as a ~250MB
  **native binary** in sibling package `@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude`
  — no cli.js); model pinned from step def; `env` stripped to
  HOME/PATH/CLAUDE_CODE_OAUTH_TOKEN (GIT_TOKEN and INTERNAL_TOKEN never enter
  the agent's tool environment).
- Every stream message → batched POST to step logs (25 msgs/1.5s, best-effort).
- Self-timeout at timeoutMinutes via AbortController (runner's +3m wait is the
  backstop for silent death).

End states (exactly ONE event per exit, retried 4× — then a loud stderr):
- normal: safety-net `git add -A; commit; push`, commits = rev-list base..HEAD,
  post cost, emit `outcome: done` + verdict + shas + sessionId.
- ask_human: tool handler POSTs the question (cap enforced server-side; cap
  error returns as tool TEXT and the agent continues), arms suspend; worker
  lets the tool result reach the transcript, aborts ~700ms later, pushes
  partial work, uploads session JSONL, emits `outcome: waiting_human` +
  questionId. Zero containers, zero spend while waiting.
- failure: `outcome: failed` + error; auth failures detected by TEXT (both
  the in-band $0 "Not logged in" result AND the thrown
  "Failed to authenticate … 401" stream error) set `authFailure: true`.

## 6. Master agent

In-process in the backend. One SDK session per conversation
(`resume: sdk_session_id`), sessions live under the session-store volume
(`HOME=/data/sessions/home`, `cwd=/data/sessions/master`) so they survive
restarts. Built-ins stripped: `allowedTools` = the 10 factory MCP tools only,
plus a disallowedTools blanket, `permissionMode: 'dontAsk'`, custom system
prompt. **Prompt includes a hard staleness rule** (re-read state through tools
every turn — added after a live failure where it answered from conversation
memory). Chat is mirrored to chat_conversations/chat_messages as it streams
(user/assistant/tool rows); history renders from the mirror only.

Tools (all wrap the same commands/projections as the API — one code path):
`list_pipeline_types` · `get_board` · `get_issue` (dependency satisfaction
computed in code) · `list_runs` · `read_artifact` · `list_pending_questions` ·
`spawn_pipeline` (relays structured refusals) · `cancel_run` ·
`answer_question` · `update_issue` (comments/labels only).

## 7. GitHub integration & artifact policy

Backend uses the REST API only (never clones). Branch per run: `issue-N` or
`task-<hex>`; created from default-branch head, reused if present.
`prepareRun` clears stale `pipeline/` files then writes `pipeline/brief.md`.

**Artifact policy (user decision)**: artifacts stay committed on the branch
WHILE the run lives (branch-as-memory for steps/retries/resumes); at
completion they are archived into `run_artifacts` and deleted from the branch
**before the PR opens** — PR diffs carry only real code; main never sees
pipeline/ files. Failed runs archive but keep branch files for debugging.
Reads (`GET /runs/:id/artifacts/:name`, Master `read_artifact`) are
archive-first with branch fallback. `.gitignore` was evaluated and rejected
(only affects untracked files; artifacts must be committed).

**Merging is HUMAN-ONLY** (user decision). The factory opens PRs, never merges.
Dependency convention: `Blocked-by: #N` in the issue body; a blocker is
satisfied when its issue is completed/closed. Enforcement is layered: the
Master usually declines from computed facts, but `spawnRun` re-checks and is
the authoritative gate (refusals: `blocked`, `already_running`,
`unknown_issue`, `issue_closed` — force overrides closed/blocked, never
existence — `issue_lookup_failed`, `unknown_pipeline`, `pipeline_disabled`,
`brief_required`, `issue_required`, plus 503 `not_ready`).

## 8. Triggers

- **Webhooks**: `POST /hooks/:triggerId`, HMAC over the RAW body
  (`X-Hub-Signature-256: sha256=<hex>`, GitHub-style; scoped content-type
  parser keeps the raw buffer; malformed JSON → 400; bad signature → 401,
  constant-time compare). Delivery id: `X-GitHub-Delivery` (fallback: body
  hash). Mapping (per trigger, jsonb): `issueNumberPath` / `briefPath` /
  `briefTemplate` (`{dot.path}` placeholders) / static `brief`/`issueNumber` /
  `filterPath`+`filterEquals`. Only mapped fields ever enter a prompt.
  Responses: 201 spawned / 200 duplicate / 202 filtered / 409 refusal.
  Idempotency is double-layered (trigger_fires unique + spawn idempotency key
  `wh-<trigger>-<delivery>`) and holds even across partial failures.
- **Cron**: `factory-cron-tick` (Inngest, `* * * * *`) evaluates enabled
  triggers' cron expressions (cron-parser); fires when the most recent cron
  time falls in the last minute; the minute bucket is the idempotency key.
- `POST /triggers {name, pipeline, mapping, schedule?}` returns the HMAC
  secret **exactly once**. `GET /triggers` lists with recent fires.

## 9. API surface (the contract Phase 5 renders)

Auth: optional `OPERATOR_TOKEN` bearer on everything except `/health`,
`/api/inngest` (Inngest signature), `/hooks/*` (HMAC), `/internal/*` (per-step
scoped tokens). Errors: `{error:{code,message,details?}}`; refusals are plain
data with 409.

```
GET  /health                      6 checks + ready (postgres, inngest, claudeToken,
                                  githubToken [live-validated], githubRepo, docker)
PUT  /settings/:key               claude-token|claude-oauth-token · github-token · github-repo
GET  /settings                    masked previews
GET/POST /pipelines · GET/PUT /pipelines/:id · POST /pipelines/:id/disable
POST /runs                        {pipeline, issueNumber?, brief, force?} + Idempotency-Key header
                                  → 201 {runId} | 200 (idempotent replay) | 409 refusal | 503 not_ready
GET  /runs?active=true&limit=     projection: currentStep "2/2: review", lastVerdictSummary, pendingQuestion
GET  /runs/:id                    full detail: definition snapshot, steps w/ attempts+verdicts+costs+shas, questions
POST /runs/:id/cancel
GET  /runs/:id/artifacts/:name    text/plain; archive-first
GET  /runs/:id/logs?step=&after=&limit=      paginated step_logs rows
GET  /runs/:id/logs/stream        SSE live tail (event: log)
GET  /board                       issue cards (number, title, boardStatus, blockedBy, activeRunId, linkedPr)
GET  /issues/:n                   detail + computed dependencies + comments + past runs
GET  /questions?status=open|answered · POST /questions/:id/answer {answer}
GET  /notifications?unread=true&limit= · POST /notifications/read {ids}|{all:true}
POST /chats → {chatId} · GET /chats · GET /chats/:id/messages (mirror)
POST /chats/:id/messages {message} → SSE turn stream: events assistant{text} ·
                                  tool.use{name,input} · done{sessionId} · error{message}
GET  /events                      one SSE stream: run.updated{id} · question.created{id} ·
                                  notification.created{id} · board.updated{number} (ids only — re-fetch the GET)
GET/POST /triggers · POST /hooks/:triggerId
POST /internal/steps/:id/logs|cost|question · POST+GET /internal/steps/:id/session   (worker tokens)
```

Board statuses: backlog / in-progress / needs-review (run completed, PR
awaiting human) / completed / blocked — computed in issueSync, refreshed on
reads when >60s stale (lag note: a just-merged PR can take up to a sync cycle
to show; a GitHub webhook pointed at /hooks fixes this once a public URL exists).

## 10. Seeded pipelines

`implement`: plan-implement (sonnet, full tool set, artifact plan.md,
retryWithFeedback 2, 45m) → review (fresh eyes, read-mostly + Write for
review.md, verdict done|reject, 20m). `implement-gated`: identical + ask_human
granted on step 1 (cap 3) with a plan-approval gate in the behavior prompt —
same machinery, one grant apart. Disabled test pipelines parked in the DB:
reject-loop-test, timeout-test, ask-cap-test (+ triggers gh-issues-test,
cron-gate-test). Behavior prompts live in `pipelines.ts` seeds; a QA step
between implement and review needs zero engine changes (reject loops are
positional).

## 11. Verification record (all live, real repo SohaibTaqat/fruitBlog)

- Phase 0 (2026-08-27): compose-from-clean; AUTH_OK in worker ($0.038,
  session real); auth negative controls (no token, bogus token) both exit 2.
- Phase 1+2 gates (2026-08-28): E2E implement run (51s, $0.24) → PR;
  forced reject re-ran implement exactly twice w/ feedback quoted in the
  retried plan.md, then failed; artifact-contract enforcement (2×); worker
  self-timeout 1m03s; runner backstop on docker-killed worker (container
  removed, logs captured); blocked + already_running refusals on both doors;
  fresh-chat status; chat-dispatch; mirror-only history; double-dispatch.
- Phase 3 gates: gated run paused with ZERO containers (147KB JSONL stored);
  resume from Master chat AND raw curl; same session id across suspend/resume;
  agent quoted the human answer in its verdict; cap-exceeded returned
  in-session, step proceeded.
- Phase 4 gates: webhook 401/spawn/replay-dedupe (held even across a partial
  failure: 3 deliveries → 1 run)/202 filtered; cron fired exactly one minute
  bucket; all 4 SSE event types + live log tail captured; exactly one
  run-completed notification per completed run.
- Campaign 1: issues 6/8/9 concurrent (3 containers) + gated answer with
  qualifiers (agent dropped its planned emoji per the answer) + dependency
  chain (#7 refused → dispatched after #6 merged). 4 PRs merged.
- Campaign 2 ("do all"): edge-case suite (new refusals; webhook 400; inngest
  outage → 503 + auto-recovery); same-LINE conflict pair conflicted as
  predicted and the recovery runbook validated (close PR → delete branch →
  re-dispatch → clean merge on new main); same-file-different-HUNK pair
  auto-merged; 6 concurrent runs peak; mid-flight cancel clean.
- Totals: 15 completed runs, $3.96 notional (subscription — cost figures are
  accounting signals, not invoices), 12 issues shipped+merged, zero dangling
  containers/questions/runs across every manufactured failure.
- Phase 5 gates (2026-08-28, all through the PRODUCTION web container :8080):
  every screen renders live campaign data; Master chat streamed a real turn
  (tool chips + answer); a `quick-docs` pipeline was created ENTIRELY in the
  UI form, the Master discovered it via `list_pipeline_types` by description
  alone ("quick-docs is the right fit") and dispatched it; the run completed
  E2E ($0.14, SECURITY.md, PR #29); issue #20 was dispatched from the board
  card and its card moved backlog → in-progress → needs-review on a parked
  page with NO reload (pure /events → query invalidation); the live log
  viewer streamed the agent's session through nginx in real time. Every UI
  action is a plain public-API call — curl-reproducible by construction.

## 12. User decisions log

- Commit at every milestone; repo at github.com/SohaibTaqat/ai-factory.
- Target: Docker Desktop locally, keep Linux-VM-portable. Checkpoint per phase.
- Human merges PRs — no auto-merge.
- Concurrency cap, rate-limit backoff, spend caps: deferred until usage data.
- Artifact policy: archive-then-clear at completion (chosen over .gitignore,
  which cannot work for tracked files).
- No frontend until the backend was hardened (done).

## 13. Gotchas for future work (all discovered the hard way)

1. Self-hosted `inngest start --signing-key` wants BARE hex; the JS SDK
   accepts the same value.
2. Agent SDK 0.3.x: CLI = native binary in platform sibling package; pin
   `pathToClaudeCodeExecutable`; peer-requires zod ^4 (inngest v3 wants zod 3
   → keep zod 4 at root, nested 3 under inngest).
3. Invalid OAuth token can surface as a THROWN 401 stream error, not only the
   in-band $0 result — detect both, by text, never exit codes.
4. Partial unique indexes need `on conflict (cols) where <predicate>`.
5. The CLI's Bash tool blocks long `sleep`s; test fixtures needing slow steps
   should use `node -e "setTimeout(...)"`; haiku disobeys test fixtures —
   use sonnet for gate fixtures.
6. Inngest `step.run` memoizes JSON — Dates come back as strings (RunCtx).
7. Fastify per-plugin content-type parsers are the way to get raw bodies for
   HMAC without affecting other routes.
8. GitHub returns 404 (not 403) for unauthorized writes; classic PAT needs
   `repo` scope; merged PRs previously dragged pipeline/ into main (fixed by
   archive-then-clear).
9. Step agents can read the PAT out of the git remote URL (clone embeds it)
   and call the GitHub API with it — observed live when a pipeline
   description said "open a PR" and the agent did so via curl (completeRun's
   ensurePullRequest adopted it idempotently; bookkeeping held). Keep
   PR-opening language out of pipeline prompts/descriptions, and prefer a
   fine-grained PAT scoped to the one target repo on the VM. Related: the
   Master skipped list_pipeline_types on a dispatch turn once; its prompt now
   REQUIRES calling it in the same turn as any spawn_pipeline.

## 14. Phase 5 — the frontend (built; done-when passed)

Separate `web` service (Vite + React + TS SPA, static build, nginx) talking
ONLY to the public API through the `/api` prefix — no bespoke
backend-for-frontend endpoints exist, which keeps "every UI action is
reproducible with curl" true by construction. Data layer: TanStack Query;
freshness is event-driven, not polled — /events sends ids, the bus maps each
event type to query-key invalidations. All streams (events bus, log tail,
chat turns) go through one SSE-over-fetch helper because the chat turn stream
is SSE on a POST and EventSource cannot send the operator bearer header.

Screens (all verified live, see §11): Board (status columns, per-card
dispatch, live movement) · Runs (table + active filter) · Run detail (steps,
attempts, verdicts, artifacts modal, commit SHAs, cancel, pending-question
answer box, live log viewer with step/attempt boundaries and scroll pinning) ·
Issue detail (deps, comments, past runs) · Master chat (mirror history, tool
chips, streamed turns) · Pipelines list + builder (create/edit steps, tool
checkboxes incl. ask_human with cap coupling, reorder; server 422s surface
verbatim) · Questions + notifications (answer + read state) · Settings/health
(masked settings PUT, health checks, operator token stored browser-side).

Dev loop: `npm run dev` in `web/` (Vite proxies /api → localhost:3000);
`.claude/launch.json` has the `web` config. Prod: `docker compose up -d
--build web` → http://localhost:8080.

Deployment checklist for the real VM (config, not code): set OPERATOR_TOKEN
(the UI sends it as a bearer from its Settings screen), real Inngest keys,
volume backups (pgdata, session-store), GitHub webhook → /hooks for instant
issue sync, `claude setup-token` on the VM, and prefer a fine-grained PAT
scoped to the target repo (gotcha 9). Expose only the `web` port publicly if
possible — the UI needs nothing else.
