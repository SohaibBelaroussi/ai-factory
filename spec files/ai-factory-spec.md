# AI Factory — Architecture Spec & Implementation Blueprint

Owner: Sohaib. Status: v2 — reconciled with all locked decisions (Aug 27, 2026).
This document is both a product spec for a human and an implementation prompt for a coding agent. Build exactly this system. Do not invent features that are not specified here. Where a choice is not specified, pick the simplest thing that preserves the session lifecycle and the state-lives-outside-processes rule.

Companion documents (authoritative for their areas):
- `architecture-expanded.md` — runner internals (Inngest), worker containers, session store, locked deployment decisions
- `backend-api.md` — the API contract (both planes), internal module seams, Docker topology
- `agent-sdk-validation.md` + `substrate-validation/VALIDATION.md` — SDK capability mapping and validated substrate facts

Locked stack: TypeScript backend · Postgres · self-hosted Inngest · Claude Agent SDK harness · Docker workers on the factory VM (subscription OAuth via `CLAUDE_CODE_OAUTH_TOKEN` env) · in-app notifications only (v1) · step logs in Postgres.

---

## 1. Goal and non-goals

### Goal

A GitHub-native AI software factory. GitHub issues are the unit of work. A **Master agent** (chat front-end + dispatch tools) receives triggers, checks project state, and spawns **pipelines** — user-defined sequences of steps, where each step is a full agentic Claude Agent SDK session in an ephemeral Docker worker that is created, does one job, and is destroyed. Pipelines update a status DB (reflected on a board/dashboard), which writes in-app notifications. Humans intervene only through explicit `ask_human` pauses or at the end (PR review).

**Build order: backend first, frontend later.** The backend is fully operable without any UI — every action is an API call (see `backend-api.md`); the operator uses curl/CLI until Phase 5.

### In scope (v1)

- Master agent: chat interface + deterministic dispatch/status tools
- Pipeline definitions as **data** (created in a UI, no code per pipeline)
- Generic pipeline runner: linear steps, one ephemeral harness session per step
- Branch-as-memory: artifacts + commits are the only context handoff between steps
- Output contracts: declared artifact + structured verdict per step, validated by the runner
- Human-in-the-loop as a per-step tool (`ask_human`) implemented as suspend/resume
- Status DB as single source of truth for runs; GitHub as source of truth for issues/code
- Issue dependency awareness (blocked-by), computed by code
- Triggers: user chat message, GitHub Actions webhook, schedule
- In-app notifications (Notification rows + `/events` SSE) on run completed/failed and `waiting-human`; external channels (Telegram/Slack/email) are later versions behind the notify adapter
- One seeded pipeline type: `implement` (autonomous and gated variants)
- Session store (JSONL persist/restore) for Master chats and suspended steps

### Later (design for, do not build in v1)

- Pipeline-builder UI polish, dashboard UI (v1 can be API + minimal board)
- More pipeline types (research, diagnostics, docs) — must require **zero engine changes**
- LLM skill that helps humans write step behavior prompts
- Parallel-conflict policy for overlapping issues (see §12)

### Non-goals

- Multi-tenant SaaS. Single operator/team.
- A workflow engine (branching graphs, conditional edges). v1 is linear + one retry rule.
- Persistent agent containers or "warm" workspaces. Sessions are throwaway.
- The Master agent doing bookkeeping in its head. All derived facts are computed in code.
- A second messaging product. Human input surfaces are: board/dashboard and Master chat.

---

## 2. System overview

```
 TRIGGERS                         MASTER AGENT                       PIPELINES
 user chat msg ─┐        ┌─────────────────────────────┐   spawn   ┌─────────────────────────┐
 github actions ─┼──────▶ │ chat LLM (judgment,         │ ────────▶ │ generic runner (code)    │
 schedule ──────┘        │ conversation)               │           │  step 1 → step 2 → … N   │
                         │   + TOOLS (all code):       │           │  one ephemeral harness   │
                         │   read: board, issues,      │           │  session per step        │
                         │         runs, artifacts,    │           └────────┬────────────────┘
                         │         pending questions   │                    │ commits, artifacts
                         │   write: spawn_pipeline,    │                    ▼
                         │          answer_question,   │           branch issue-N + pipeline/
                         │          update_issue       │                    │
                         └──────────────┬──────────────┘                    ▼
                                        │ reads/writes            STATUS DB ──▶ board/dashboard
                                        └────────────────────────▶          └──▶ notifications
```

Mental model — one job per layer:

1. **Master agent** = chat LLM for judgment + conversation. Everything else it does is a tool call into deterministic code.
2. **Pipeline definition** = data. Name, description, input schema, ordered steps.
3. **Runner** = code. Executes any pipeline definition. No LLM.
4. **Step** = one ephemeral harness session. Full agent (can read code, search web, run tools) with a scoped tool list.
5. **Branch** = the pipeline's memory. Artifacts in `pipeline/`, code as commits. Nothing else survives a step.
6. **Status DB** = single source of truth for runs/steps/questions. Board and dashboard are projections of it. GitHub is the source of truth for issues, code, PRs.
7. **State lives outside processes** at every level: a fresh Master chat reconstructs reality by reading state; a new step session reconstructs context by reading the branch.

---

## 3. Core rules (invariants)

1. **Ephemeral sessions.** A step session is born empty, clones the branch, works, persists via commits/artifacts, and is destroyed. Nothing else survives. Failures also destroy the session; logs are persisted to the Step Run row first.
2. **Judgment in LLMs, bookkeeping in code.** Dependency checks, status transitions, chain sequencing, validation, notifications: code. Understanding an issue, planning, implementing, reviewing, choosing a pipeline for a vague request: LLM.
3. **Pipelines are data.** Adding a pipeline type = inserting rows, never deploying code.
4. **Context passes by reference.** Steps receive pointers to artifacts plus short summaries, never full pasted transcripts.
5. **Every step output is contract-checked.** Declared artifact exists + verdict parses, or the step is `failed`.
6. **Nothing blocks while waiting for a human.** `waiting-human` means no process is running and no tokens are burning.
7. **The Master never sees raw streams.** Summaries and states only. No transcripts, no diffs, no secrets.

---

## 4. Domain model

DB: Postgres (or SQLite for v1). Names can vary; fields and relationships cannot be dropped.

```ts
type PipelineDefinition = {
  id: string
  name: string                 // "implement", "implement-gated", "research"
  description: string          // READ BY THE MASTER to choose a pipeline — write it as prompt text
  inputSchema: {               // what the Master must provide on spawn
    issueNumber?: "required" | "optional"
    brief: "required"          // free-text task brief from the Master
  }
  steps: StepDefinition[]      // ordered, linear
  enabled: boolean
}

type StepDefinition = {
  index: number
  name: string                 // "plan-implement", "review"
  behaviorPrompt: string       // human-authored in UI. Static. No variables. Role/objective/quality bar only.
  model: string                // per-step model choice
  allowedTools: string[]       // e.g. ["git", "web_search", "ask_human"] — least privilege, default deny
  outputArtifact: string | null // e.g. "plan.md", "review.md" — validated by runner. null only when the step's output is commits + verdict alone. Every step ALWAYS produces a verdict.
  askHumanCap: number          // default 3. 0 if ask_human not granted.
  retryWithFeedback: number    // default 0. If the NEXT step's verdict is reject, re-run THIS step with the rejection appended, at most N times.
  timeoutMinutes: number       // hard kill + step failed
}

type PipelineRun = {
  id: string
  pipelineId: string
  issueNumber: number | null
  branch: string               // "issue-5"
  brief: string                // task brief from the Master (or trigger mapping)
  status: "running" | "waiting-human" | "failed" | "completed" | "cancelled"
  currentStepIndex: number
  createdBy: "chat" | "webhook" | "schedule"
  createdAt: Date
  endedAt?: Date
  costUsd?: number
}

type StepRun = {
  id: string
  pipelineRunId: string
  stepIndex: number
  attempt: number              // for retryWithFeedback
  status: "pending" | "running" | "waiting-human" | "validating" | "done" | "failed"
  harnessSessionId?: string    // NEEDED FOR RESUME
  verdict?: Verdict
  askHumanCount: number
  startedAt?: Date
  endedAt?: Date
  logRef?: string              // pointer to persisted session log (for human live/replay viewer)
  commitShas: string[]
}

type Verdict = {               // the machine-readable tail of every step's output
  status: "done" | "failed" | "reject"   // "reject" only meaningful from review-type steps
  summary: string              // ONE LINE. Feeds list_runs and the board. Written at the source.
  detailsArtifact?: string     // e.g. "review.md" for the full reasoning
}

type Question = {              // ask_human
  id: string
  pipelineRunId: string
  stepRunId: string
  kind: "text" | "multiple-choice"
  body: string
  choices?: string[]
  answer?: string
  status: "open" | "answered"
  createdAt: Date
}

type IssueCache = {            // projection of GitHub, refreshed on trigger/webhook
  number: number
  title: string
  boardStatus: "backlog" | "in-progress" | "needs-review" | "completed" | "blocked"
  blockedBy: number[]          // parsed from issue metadata/labels
  activeRunId?: string
  linkedPr?: string
}

type Notification = {          // in-app only in v1; written by the runner via the notify adapter
  id: string
  event: "run-completed" | "run-failed" | "waiting-human"
  pipelineRunId: string
  questionId?: string
  summary: string              // the verdict one-liner / question text
  read: boolean
  createdAt: Date
}

type Setting = {               // operator settings via PUT /settings (UI later); provisioner reads at provision time
  key: "claude-oauth-token" | "github-token" | string
  value: string                // token rotation = update the row, no restart
}

type StepLogEvent = {          // step_logs table — tool-call stream per step (live viewer reads this)
  id: string
  stepRunId: string
  event: unknown               // serialized SDK stream event
  ts: Date
}

// Chat mirror (Master conversations — powers chat history UI; session JSONL is never parsed)
type ChatConversation = { id: string; sdkSessionId: string; title: string; lastMessageAt: Date }
type ChatMessage = { id: string; conversationId: string; role: string; content: string; ts: Date }
```

GitHub remains authoritative for issue content, code, branches, PRs. The DB is authoritative for pipeline definitions, runs, steps, questions. `IssueCache` is a convenience projection — never edit it except from GitHub data.

---

## 5. Master agent

Two halves, kept separable:

- **Conversational front-end (LLM).** Talks to the user. Per-conversation context; a fresh chat has no memory and must reconstruct reality via read tools. Never carries project state in its head across chats.
- **Dispatch/status machinery (code).** Every tool below is deterministic code. The LLM decides *what to do*; the tools decide *what is true*.

### 5.1 Read tools

| Tool | Returns |
|---|---|
| `list_pipeline_types()` | name, description, inputSchema per enabled pipeline. Descriptions are how the Master picks — they are prompt text. |
| `get_board()` | every issue: number, title, boardStatus, blockedBy, activeRunId. One call = whole project state. |
| `get_issue(n)` | body, comments, labels, dependencies **with satisfied/unsatisfied computed**, linked branch/PR, past runs on this issue with outcomes. |
| `list_runs(activeOnly?)` | per run: id, pipeline name, issue, `currentStep name + index ("2/4: review")`, step status, startedAt, last verdict summary (one line), pending question text if waiting-human. |
| `read_artifact(runId, name)` | fetch an artifact from the run's branch on demand. Never auto-injected. |
| `list_pending_questions()` | all open Questions across runs. |

Derived facts are computed inside tools: `get_issue` returns `blocked: true, missing: [1, 2]` — the Master never traverses the dependency graph itself.

### 5.2 Write tools

| Tool | Behavior |
|---|---|
| `spawn_pipeline(name, {issueNumber?, brief})` | Validates: pipeline enabled, issue not blocked (unless `force`), no active run on the issue. Creates PipelineRun + branch, enqueues step 1. Returns run id or a structured refusal (`blocked_by: [1,2]`, `already_running: runId`). |
| `answer_question(questionId, answer)` | Stores answer, triggers session resume (§8). This makes chat a second human-input surface beside the board. |
| `cancel_run(runId)` | Marks cancelled; kills live session if any. |
| `update_issue(n, …)` | Labels/comments/status where the Master legitimately manages the board (e.g. marking blocked). |

### 5.3 Master system prompt (sketch)

```
You are the Master agent of an AI software factory. You converse with the
user and dispatch pipelines. You hold no project state — always read it
through your tools before answering questions about status. Choose a
pipeline by matching the user's request against pipeline descriptions.
Refuse to double-dispatch; relay structured refusals honestly. When a run
is waiting on a human question you may collect the answer in chat and
submit it. You never implement, plan, or review work yourself — pipelines
do that.
```

### 5.4 Implementation facts (locked)

- One SDK session per conversation; continuing a chat = `resume(sessionId)`. Session JSONL persisted to the session store after each turn.
- Tools are **in-process MCP tools** wrapping the same command functions as the API (one code path).
- **All SDK built-in tools stripped** (no Bash, no Write, no file access) — the Master can only act through factory tools.
- Chat messages mirrored to the DB as they stream (never parse session JSONL); the mirror powers chat history.

### 5.5 What the Master must NOT see

Live transcripts / tool-call logs (human debugging surface only), raw diffs (humans review code via PRs), secrets and env. Not as prompt guidance — these are simply not reachable from any tool it has.

---

## 6. Pipelines and the runner

### 6.1 Runner

One generic executor, pure code — implemented as an **Inngest durable function per run** (self-hosted Inngest on the VM). It owns control flow only and uses **dispatch-and-wait**: it never runs a harness session in-function; it provisions a worker container, then `waitForEvent`. Event catalog (its entire vocabulary): `pipeline.run.requested` · `step.finished` · `step.waiting_human` · `question.answered` · `pipeline.run.completed` · `pipeline.run.failed`. Workers emit events directly to Inngest on the Docker network; rows (logs/cost/questions) go through the internal API. Status DB is the single source of truth for domain state; Inngest holds only execution/wait state, and stays behind the Runner interface.

```
on spawn: create branch issue-N (or reuse the run's branch), write brief to pipeline/brief.md, enqueue step 1
per step:
  build prompt (§7) → provision harness session → run
  on session end: validate output contract
    artifact present (if declared) AND verdict parses → step done
      → if verdict.status == "reject" and previous step has retryWithFeedback budget:
          re-enqueue previous step (attempt+1) with rejection appended to its runtime context
      → else enqueue next step, or complete the run if last
    else → step failed → run failed → notify
  on ask_human: §8
on run completed/failed: update IssueCache/board, fire notification
```

Strictly linear. The only control flow beyond "next" is `retryWithFeedback`. If a pipeline needs more than that, it is two pipelines, or it waits for v2.

### 6.2 Step session lifecycle (state machine — implement exactly)

```
pending
 → provision harness session (empty container/workspace)
 → clone repo, checkout run branch
 → grant allowedTools only (default deny)
 → inject prompt layers (§7)
 → running                    (log streamed to StepRun.logRef for the human viewer)
 → [optional] waiting-human   (ask_human: session suspended, process dead, resumable by id)
 → validating                 (contract check by runner)
 → done | failed
 → session destroyed          (ALWAYS — success, failure, or timeout)
```

After destroy, nothing survives except: commits on the branch, artifacts in `pipeline/`, the persisted log, the StepRun row, and (only if suspended) the session JSONL in the session store. The next step re-clones. No warm workspaces, ever.

Worker facts (validated 2026-08-27):

- Auth: `CLAUDE_CODE_OAUTH_TOKEN` env var only (from the Setting row, injected by the provisioner). No API key, no `~/.claude` mount.
- **Canonical cwd `/work` fleet-wide** — makes cross-container resume a copy of the JSONL to `~/.claude/projects/-work/`.
- **Pin `pathToClaudeCodeExecutable` and the model** in the worker — both resolve nondeterministically otherwise.
- **Auth failure is in-band** ("Not logged in", exit 0, $0 cost) — detect via result text + zero cost, route to a factory-health notification, never a step retry.
- Verdict shape enforced via SDK `outputFormat` (JSON schema); the runner still checks the artifact exists on the branch.
- Overhead budget: ~2.5–3 s container+CLI cold start per step. Resume keeps the same session id.

### 6.3 Seeded pipeline type: `implement`

| # | Step | Tools | Output | Notes |
|---|---|---|---|---|
| 1 | plan-implement | git, web_search | commits + `plan.md`, verdict | Plans then implements in one session — continuity is the feature here. Runs repo tests before finishing. `retryWithFeedback: 2`. |
| 2 | review | git (read) | `review.md`, verdict `done|reject` | Fresh session, sees only diff + plan + brief. Fresh eyes are the feature here. Reject loops step 1 (max 2), then run fails → human. |

`implement-gated` = same two steps, plus `ask_human` granted on step 1 with a behavior prompt that requires plan approval before implementing. **Same machinery, one tool grant — no engine difference between autonomous and gated pipelines.**

Splitting rule for authors (surface it in the pipeline-builder UI): split steps where a fresh context is a feature (review, human gates, retry boundaries); merge where continuity is the feature (plan → implement).

---

## 7. Step prompt layers

Every step session receives exactly three layers:

**Layer 1 — Harness prompt.** Written once by the operator, identical for every step of every pipeline. The global rails:

```
You are one step in a pipeline inside an AI factory.
Your input: the task brief and the artifacts under pipeline/ on the
current branch, plus the runtime context below. Read what you need with
your own tools — pointers are given, content is not pasted.
Your session is ephemeral: anything not committed to the branch or
written under pipeline/ is destroyed when you finish.
Finish by writing your declared output artifact (if any) and ending your
final message with a verdict block:

  ```verdict
  status: done | failed | reject
  summary: <one line — this feeds the status board>
  ```

If you have the ask_human tool, use it only for decisions you cannot
make yourself, and prefer deciding. Stay within this step's job; do not
do the next step's work.
```

**Layer 2 — Behavior prompt.** Human-authored in the pipeline-builder UI. Static, no variables. Role, objective, quality bar. (Later: an LLM skill can help write these; it only ever writes this layer because layers 1 and 3 already guarantee the mechanical aspects.)

**Layer 3 — Runtime context.** Assembled by the runner, never authored:

```
brief: <the Master's task brief>
issue: #5 — <title> (read the full issue with your tools if needed)
branch: issue-5
expected output artifact: review.md
previous step: plan-implement — verdict: done — "implemented X behind flag Y"
artifacts available: pipeline/brief.md, pipeline/plan.md
[on retry] rejection feedback: <verdict summary + pointer to review.md>
[if gated] human replies so far: <appended on resume>
```

By reference, small, and validated: the runner checks the declared artifact and verdict after the session, so even a badly written layer 2 still yields a step that reads its input and emits parseable output — the rails live in layers 1 and 3, which the operator controls. Layers 1+2 are a stable prefix (prompt-cache-friendly).

---

## 8. Human-in-the-loop: `ask_human`

From the agent's perspective: a tool. From the infrastructure's perspective: **suspend/resume, never a blocked process.**

```
agent calls ask_human(body, choices?)
 → handler: create Question row, set StepRun + PipelineRun to waiting-human,
   persist harnessSessionId, fire notification, TERMINATE the session process
   (workspace may be destroyed; the resumable session transcript is what persists)
human answers — from the board/dashboard OR from Master chat (answer_question tool)
 → runner resumes the harness session by id with the answer as the next message
 → agent continues mid-step, sees the answer as the tool result
 → statuses back to running
```

Rules:

- `ask_human` is a per-step grant in `allowedTools`. Not granted → the tool does not exist for that session.
- `askHumanCap` (default 3) enforced by the handler — over cap, the tool returns an error telling the agent to decide or fail. Prevents the autonomous factory becoming a notification factory.
- Multi-turn is natural: approve/iterate loops are just repeated ask → resume cycles within the cap.
- While `waiting-human`: zero processes running, zero spend. Resume hours or days later is identical to resume in seconds.

---

## 9. Status, board, notifications

- The **DB is the single source of truth for runs**. The board and (later) dashboard are read-only projections of `IssueCache` + `PipelineRun` + `StepRun` + `Question`.
- Board columns: `backlog / in-progress / needs-review / completed / blocked`, with blocked-by shown on the card. `needs-review` = run completed, PR awaiting human. `blocked` is computed from dependencies by code.
- **Summaries are written at the source**: every verdict carries a one-line summary precisely so `list_runs`, the board card, and notifications are cheap projections. The step output contract feeds the read model — two ends of one pipe.
- Notifications: the runner writes Notification rows on `run-completed`, `run-failed`, `waiting-human`; the `/events` SSE stream pushes them to any connected client. **In-app only in v1** — the notify call is an adapter; external channels are later versions, new callers only.
- Step logs live in the `step_logs` Postgres table (append as they stream; live viewer reads via LISTEN/NOTIFY or polling).
- Dashboard (later) adds: live session viewer, run history/replay, cost per run. These read the same DB — no new write paths.

---

## 10. Triggers

All three trigger paths converge on the same two entry points: Master conversation or direct `spawn_pipeline`.

| Trigger | Path |
|---|---|
| User chat message | Master conversation → Master decides → `spawn_pipeline` |
| GitHub Actions / webhook | Receiver validates secret → maps payload to `{pipeline, issueNumber, brief}` → `spawn_pipeline` directly (no LLM needed for a well-defined mapping) or → a Master job for fuzzy payloads |
| Schedule (cron) | Scheduler row → same as webhook path |

Webhook payloads are sanitized before entering any prompt (no raw headers/secrets).

---

## 11. Build phases (ship in this order; do not start N+1 before N's done-when passes)

Backend first (Phases 0–4, fully operable and E2E-tested via API); frontend is Phase 5, a separate `web` service that is pure rendering over the API.

### Phase 0 — Skeleton
Docker compose (`pg`, `inngest`, `backend` on the `factory` network). Migrations for the full domain model (§4). Settings endpoints (`PUT /settings/claude-token`, github token). Health/setup-check endpoint that reports token, git credential, Inngest, and Postgres status and refuses dispatch until all green. Worker image built (SDK + pinned CLI, canonical cwd `/work`).
**Done when:** `docker compose up` from clean → health endpoint green after tokens are set; worker image runs the substrate-validation AUTH_OK test against it.

### Phase 1 — Runner core (no Master, no UI)
Pipeline definitions in DB (seed `implement` via fixture). Inngest `runPipeline` function (dispatch-and-wait). Provisioner module (Docker socket) spawning worker containers. Workers: clone branch, 3 prompt layers, `outputFormat` verdict, log/cost via internal API, one event, die. Contract validation. `retryWithFeedback`.
**Done when:** `POST /runs` spawns `implement` on a real issue in a test repo; commits land on `issue-N`; `plan.md` and `review.md` exist; a forced review-reject re-runs step 1 with feedback exactly twice then fails the run; a second run re-clones (assert no dirty workspace reuse); a step timeout kills and fails cleanly; step_logs rows stream during the run.

### Phase 2 — Master agent
Master service: SDK sessions, in-process MCP tools wrapping the same commands, built-ins stripped, chat mirror. Chat endpoints with SSE. IssueCache sync from GitHub. Dependency computation.
**Done when:** "implement issue 5" via `POST /chats/:id/messages` (curl) dispatches; dispatching a blocked issue returns the structured refusal and the Master relays it; a *fresh* chat answers "what's running?" correctly via tools; double-dispatch is refused; chat history renders from the DB mirror alone.

### Phase 3 — Human-in-the-loop
`ask_human` tool → internal API → Question row + Notification + suspend (JSONL to session store, `step.waiting_human` event, worker exits). `POST /questions/:id/answer` + Master's `answer_question` → `question.answered` → fresh worker restores JSONL at `/work` and resumes. `implement-gated` seeded.
**Done when:** gated run pauses at plan approval with zero live containers (assert via docker ps); answering via curl resumes mid-step and the agent references the answer; cap exceeded → tool errors and the step proceeds; an answer given a day later still resumes; same session id across suspend/resume.

### Phase 4 — Triggers + notifications + events
Webhook receiver (HMAC) + payload mapping. Cron via Inngest. Notification rows on the three events. `/events` SSE stream (run.updated, question.created, notification.created, board.updated). Idempotency keys on spawn.
**Done when:** a signed webhook spawns a scoped run (bad secret → 401, replayed delivery does not double-spawn); a schedule fires once under a test clock; completing a run writes exactly one Notification and emits it on `/events`.

**→ Backend E2E milestone:** after Phase 4, the full operator story (§13) is executable end-to-end with curl only. This is the acceptance gate before any frontend work.

### Phase 5 — Frontend (`web` service)
Separate container, static build, talks only to the public API. Screens: Master chat, board, run detail + live log viewer, pipeline builder (steps, behavior prompts, tool checkboxes incl. `ask_human`, output artifact field, retry/caps), notification center + pending-questions view, settings (tokens, health).
**Done when:** a pipeline created entirely in the UI (never touching code) is discovered by the Master via its description and runs end-to-end; the board reflects a run's life live over `/events`; every UI action is reproducible with curl (the UI test).

### Deferred (do not fake)
Dashboard polish + live viewer + cost tracking. Research/diagnostic pipeline types (must be pure data). Prompt-writing LLM skill. Parallel-conflict policy (§12). Multi-repo.

---

## 12. Open questions (known, deliberately unsolved in v1)

1. **Parallel runs touching the same files.** Branch-per-issue prevents workspace collisions but not merge conflicts. v1 mitigation: the Master refuses to dispatch an issue whose `blockedBy` is unsatisfied, and humans set dependencies to serialize overlapping work. Real policy (file-overlap detection, auto-serialization, rebase step) is v2.
2. **Verdict vocabulary growth.** v1 is `done | failed | reject`. Resist adding states until a real pipeline needs one (`needs-replan` is the likely first).
3. **Cost/time rails per run.** Not in v1 scope but cheap: `timeoutMinutes` exists per step; add a per-run spend cap when cost data is available from the harness. Do not run unbounded loops — `retryWithFeedback` is the only loop and it is capped by construction.
4. ~~Which harness~~ — **decided and validated**: Claude Agent SDK in Docker workers. The thin Provisioner interface (`start(stepRun)` / `kill(id)`) is retained as the seam for running workers elsewhere later.
5. **Subscription rate limits vs throughput** (standing policy): parallel pipelines can exhaust 5-hour/weekly caps; the runner treats rate-limit errors as retryable-with-backoff; sustained heavy use may eventually justify API billing.

---

## 13. One-page operator story (README material)

You define pipelines in a UI — each step is a prompt, a model, and a tool checklist. You tell the Master agent "implement issue 5" (or a webhook/schedule does). It checks the board and dependencies, then spawns the pipeline. Each step runs as a throwaway coding-agent session on the issue's branch, leaves its work as commits and artifacts, and dies. A review step with fresh eyes gates the loop. If a step needs you, everything stops costing money until you answer — from the board or from chat. When the run ends, the board updates and you get a notification with a one-line summary. A fresh chat with the Master knows exactly where everything stands, because nothing important ever lived in a chat's memory.
