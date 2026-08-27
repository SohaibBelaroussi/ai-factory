# AI Factory — Backend API Contract

Companion to `architecture-expanded.md`. This is the backend's external contract; the other two contracts (DB schema, event catalog) live in the spec and expanded architecture docs. The UI, CLI, and webhooks are all clients of this API — the backend is fully operable without any of them.

---

## Design rules

1. **One code path per action.** `POST /runs` and the Master's `spawn_pipeline` tool call the same internal command function (preflight → create run → emit event). Chat, UI, CLI, and webhooks are four doors into one room. No action is ever implemented twice.
2. **Two planes.** Public plane (operator auth) and internal plane (workers, per-step scoped tokens). A worker token can only write its own step's rows.
3. **Reads are projections, writes are commands.** GET endpoints read the Status DB. Every mutation goes through a named command function that also emits events and writes notifications.
4. **The UI test:** every action the UI offers must be a plain API call reproducible with curl. Anything only possible through the UI is in the wrong layer.

---

## Auth

| Client | Mechanism |
|---|---|
| Web UI | Session cookie (single operator login) |
| CLI / scripts | Bearer token (personal access token) |
| Webhooks | Per-trigger HMAC secret |
| Workers | Per-step-run scoped token, injected at provision, expires when the step ends |

---

## Public plane

### Pipelines (definitions — data only)

```
GET    /pipelines                 list (the Master's list_pipeline_types reads the same)
POST   /pipelines                 create {name, description, inputSchema, steps[]}
GET    /pipelines/:id
PUT    /pipelines/:id             edit steps/prompts/tools/model/caps
POST   /pipelines/:id/disable     never hard-delete — runs reference definitions
```

### Runs

```
POST   /runs                      {pipeline, issueNumber?, brief}
                                  → 201 {runId}
                                  → 409 structured refusal: {reason: "blocked", blockedBy:[1,2]}
                                                          | {reason: "already_running", runId}
GET    /runs?active=true          list: id, pipeline, issue, current step (name + "2/4"),
                                  step state, startedAt, last verdict summary,
                                  pending question text if waiting-human
GET    /runs/:id                  full detail: steps, attempts, verdicts, costs, commit shas
POST   /runs/:id/cancel
GET    /runs/:id/artifacts/:name  proxied read from the run branch (plan.md, review.md, …)
GET    /runs/:id/logs?step=&after=  paginated rows from step_logs
```

### Board / issues

```
GET    /board                     projection: issues + status column + blockedBy + activeRunId
GET    /issues/:n                 detail: body, labels, dependencies WITH computed satisfaction,
                                  linked branch/PR, past runs + outcomes
```

### Questions (ask_human)

```
GET    /questions?status=open
POST   /questions/:id/answer      {answer} → stores answer, emits question.answered
```

Single entry point for answers — UI, the Master's `answer_question` tool, and any future channel (Telegram button, email reply) all call this. New channels = new callers, zero new logic.

### Chat (Master agent)

```
POST   /chats                     start conversation → {chatId}
GET    /chats                     sidebar (from the DB chat mirror — never from session JSONL)
GET    /chats/:id/messages
POST   /chats/:id/messages        user turn → SSE stream of the Master's response
                                  (tool-use events included so the UI can show activity)
```

### Live updates

```
GET    /events                    one SSE stream for the whole UI:
                                    run.updated        (status/step transitions)
                                    question.created
                                    notification.created
                                    board.updated
GET    /runs/:id/logs/stream      SSE tail of step_logs (live session viewer)
```

The UI subscribes to `/events` once and re-fetches the affected resource on each event — events carry ids, not payloads (avoids projection drift; the GET is the truth).

### Notifications (in-app only, v1)

```
GET    /notifications?unread=true
POST   /notifications/read        {ids} | {all: true}
```

Written by the runner on `run-completed`, `run-failed`, `waiting-human`. External channels (Telegram/Slack/email) are later versions behind the same notify adapter.

### Triggers

```
POST   /hooks/:triggerId          public, HMAC-signed; maps payload → same spawn command
GET    /triggers                  list + recent fires
POST   /triggers                  create {name, pipeline, mapping}
```

---

## Internal plane (workers only)

Scoped token per step run; can only touch its own step.

```
POST   /internal/steps/:id/logs      append tool-call events (batched, streamed during run)
POST   /internal/steps/:id/cost      {totalCostUsd} on completion
POST   /internal/steps/:id/question  ask_human handler target: creates Question row,
                                     writes notification, returns questionId
```

**Not on the API:** `step.finished` / `step.waiting_human` — workers emit these directly to the self-hosted Inngest server on the Docker network. Split rationale: **events drive control flow** (Inngest's job), **rows drive observability** (DB's job). The runner (Inngest functions inside the backend service) consumes events and calls the same command functions as the public plane.

---

## Backend internal modules (not endpoints, but the seams that matter)

| Module | Responsibility | Notes |
|---|---|---|
| Commands | spawnRun, answerQuestion, cancelRun, … | The single code paths. API routes, Master tools, and webhook mappers are thin wrappers around these. |
| Runner | Inngest durable functions | Control flow only; consumes the event catalog; calls Commands + writes domain rows. |
| Provisioner | `start(stepRun)` / `kill(id)` | The ONLY privileged module — talks to the Docker API (mounted socket) to spawn worker containers on the shared network. Isolated behind this interface from day one; it is the future seam for running workers elsewhere. |
| Master service | SDK sessions + in-process MCP tools | Mirrors chat to DB; tools wrap Commands and projections. |
| GitHub adapter | issue sync, branch ops, artifact reads | Feeds IssueCache; computes dependency satisfaction. |
| Notify adapter | writes Notification rows (v1) | Later versions add channels here; nothing else changes. |

---

## Deployment topology (target)

All services on one Docker network; runs on any machine with Docker:

```
docker network: factory
  pg           Postgres (Status DB, step_logs, chat mirror)
  inngest      self-hosted Inngest (+ redis if its deployment mode requires)
  backend      API (both planes) + runner functions + Master service + provisioner
  web          frontend, static build; talks only to backend's public plane
  worker-*     spawned dynamically by the provisioner; env: step config,
               CLAUDE_CODE_OAUTH_TOKEN, git credentials, scoped internal token;
               canonical cwd /work; destroyed after one step
```

Volumes: pg data; session store (JSONL for Master chats + suspended steps). Operator token setup (claude setup-token flow) is a packaging concern, deliberately deferred.

---

## Conventions

- JSON everywhere; errors as `{error: {code, message, details?}}` with meaningful HTTP status (409 for refusals, 403 for scope violations, 422 for validation).
- All list endpoints paginate with `?after=<cursor>&limit=`.
- Timestamps ISO-8601 UTC.
- Idempotency: `POST /runs` accepts an optional `Idempotency-Key` header (webhook retries must not double-spawn).
- Structured refusals are data, not error strings — the Master relays them and the UI renders them.
