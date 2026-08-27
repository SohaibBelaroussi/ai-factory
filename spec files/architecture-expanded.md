# AI Factory — Expanded Architecture

Expands `ai-factory-architecture.md` with the agreed runner internals (Inngest), the session store, and the worker-container substrate. The Claude Agent SDK is the implementation resource for every LLM-touching box (see `agent-sdk-validation.md`); it is referenced here only where it fixes an architectural fact.

---

## Diagram

```
                    ┌────────────────────────────────────────────────────┐
                    │                       HUMAN                        │
                    │           chat ↔ Master · board/dashboard          │
                    └────────┬─────────────────────────────▲────────────┘
                             │ messages / answers          │ status, notifications,
                             ▼                             │ pending questions
  TRIGGERS          ┌──────────────────────────┐           │
 ┌─────────────┐    │       MASTER AGENT       │           │
 │ user chat   │───▶│  chat LLM (SDK session,  │           │
 └─────────────┘    │  resume per conversation)│      ┌──────────────┐
 ┌─────────────┐    │  + in-process MCP tools  │◀────▶│  STATUS DB   │
 │ github      │──┐ │  (code): reads + spawn + │      │ runs · steps │
 │ webhooks    │  │ │  answer_question         │      │ questions ·  │
 └─────────────┘  │ └────────────┬─────────────┘      │ chat mirror  │
 ┌─────────────┐  │              │ emit                └──▲───────▲───┘
 │ schedule    │──┤              ▼ "pipeline.run.requested"│       │
 └─────────────┘  │ ┌──────────────────────────┐  domain   │       │
                  └▶│   PIPELINE RUNNER        │  writes    │       │
   PIPELINE         │   (Inngest durable fn)   │───────────┘       │
   DEFINITIONS ────▶│  control flow only:      │                   │
   (data)           │  provision → waitForEvent│                   │
                    │  → validate → next/retry │                   │
                    └───────┬──────────▲───────┘                   │
              provision     │          │ events:                   │
              container     │          │  step.finished            │
                            ▼          │  step.waiting_human       │
                    ┌──────────────────┴───────┐  question.answered│
                    │  STEP WORKER CONTAINER   │                   │
                    │  (ephemeral, dumb):      │───────────────────┘
                    │  clone branch → restore  │   step logs, cost
                    │  session? → SDK query()  │
                    │  → commit/persist →      │
                    │  emit ONE event → die    │
                    └───┬──────────────────┬───┘
                        │ commits +        │ suspended-session JSONL
                        ▼ artifacts        ▼
            ┌──────────────────┐   ┌──────────────────┐
            │ GITHUB / BRANCH  │   │  SESSION STORE   │
            │ issues·code·PRs· │   │ (object storage: │
            │ pipeline/ files  │   │ JSONL for Master │
            └──────────────────┘   │ chats + suspended│
                                   │ steps)           │
                                   └──────────────────┘
```

---

## What changed vs the high-level doc

Three boxes were added or opened up; everything else is unchanged.

1. **Pipeline Runner** is now concrete: an Inngest durable function per run.
2. **Step Worker Container** is its own component (the execution substrate).
3. **Session Store** is a new component, required by suspend/resume and Master chat.

---

## Components

### 1. Triggers
Unchanged — with one implementation fact: all three arrive as **Inngest events** (webhook ingestion, cron triggers, and the Master's `spawn_pipeline` emitting `pipeline.run.requested`). One mechanism serves all triggers.

### 2. Master Agent
**What:** Chat LLM + deterministic tools, as before.
**Agreed implementation facts (SDK):**
- One SDK session per conversation; continuing a chat = `resume(sessionId)`. Fresh chat = fresh session, reconstructs reality via tools.
- Tools are **in-process MCP tools** — derived facts (blocked?, already running?) computed inside them, mechanically enforcing "judgment in LLM, bookkeeping in code."
- **All built-in tools stripped** (no Bash, no Write, no file access). The Master can act only through the factory tools — "never does pipeline work itself" is enforced, not requested.
- Chat messages are **mirrored to the Status DB as they stream** (never parse session JSONL). The DB powers the chat history UI; the JSONL powers resume.
**Constraints:** unchanged from the high-level doc.

### 3. Pipeline Definitions
Unchanged: data only. New implementation fact: a step's `allowedTools` list is passed **verbatim** to the SDK per session — adding a pipeline type still requires zero engine changes. `disallowedTools` hard-denies; `bypassPermissions` is banned everywhere.

### 4. Pipeline Runner (Inngest)
**What:** One Inngest durable function per pipeline run, triggered by `pipeline.run.requested`. It owns **control flow only**: sequencing, retries, timeouts, durable waits, validation.

```
runPipeline(event: pipeline.run.requested)
  create run row, branch, write pipeline/brief.md
  for each step (and retry attempt):
    step.run("provision-{step}-{attempt}")        // start worker container, return immediately
    evt = step.waitForEvent("step.finished" | "step.waiting_human", match runId)
    while evt == step.waiting_human:
      ans = step.waitForEvent("question.answered", match questionId)   // days OK, zero cost
      step.run("resume-{...}")                    // fresh container, resume sessionId
      evt = step.waitForEvent(...)
    validate output contract (code): artifact exists on branch + verdict parses
      reject + previous step has retryWithFeedback budget → re-enqueue previous (attempt+1)
      fail → run failed
      done → next step
  emit pipeline.run.completed → notification
```

**Constraints:**
- **Never runs a harness session in-function.** Sessions run 30–60+ min; Inngest functions stay short. Dispatch-and-wait always.
- **Status DB is the single source of truth for domain state.** The runner writes every domain transition to the DB as it happens; Inngest holds only execution/wait state. The board never reads Inngest.
- **Inngest stays behind the Runner interface.** Definitions, verdicts, and the DB schema don't know it exists; the engine is swappable plumbing.
- Deterministic: routing comes from parsed verdicts + definition rules. No LLM anywhere in the runner.

**Event catalog (the runner's entire vocabulary):**
`pipeline.run.requested` · `step.finished` · `step.waiting_human` · `question.answered` · `pipeline.run.completed` · `pipeline.run.failed`

### 5. Step Worker Container
**What:** The execution substrate — an ephemeral **Docker container on the factory VM** (decided; validated 2026-08-27, see `substrate-validation/VALIDATION.md`) that runs exactly one step session and dies.
**Auth:** Subscription OAuth. `claude setup-token` once on the VM host; runner injects `CLAUDE_CODE_OAUTH_TOKEN` per container via env (same path as git credentials). No API key, no `~/.claude` mount. Token is long-lived but not eternal — fire a factory-health notification on auth failure.
**Lifecycle:** clone repo + checkout run branch → restore session JSONL from Session Store if resuming → run SDK `query()` with (harness prompt + behavior prompt) as system prompt, runtime context as the message, step's `allowedTools`, step's model → stream logs + write cost to Status DB → commit/persist artifacts → emit exactly one event (`step.finished` with verdict, or `step.waiting_human`) → exit.
**Constraints:**
- Dumb: no routing decisions, no DB reads beyond its own step row, no knowledge of the pipeline shape.
- Ephemeral: destroyed always (success, failure, timeout). Survivors: commits, artifacts, persisted log, JSONL (only if suspended), the event.
- Verdict is schema-enforced via SDK `outputFormat` (shape guaranteed); the **runner** still verifies the artifact exists on the branch (filesystem truth is checked in code).
- Explicit permission config; never `--dangerously-skip-permissions`.
- Hooks (per-session, from the step definition) may gate tool calls (e.g. Bash command policy) and audit to the log — enforcement beyond the allowlist.
- **Canonical cwd `/work` fleet-wide.** Session files are keyed by encoded cwd; a fixed cwd makes cross-container resume trivial and cwd-mismatch impossible.
- **Pin `pathToClaudeCodeExecutable` and the model explicitly** — both resolve nondeterministically otherwise (validated gotchas).
- **Auth failure is in-band**: "Not logged in" returns as a *successful* result with exit 0 and $0 cost. The worker/runner must detect it from result text + zero cost, never from the exit code, and route it to a factory-health notification (not a step retry).
- Validated overhead: ~2.5–3 s container+CLI cold start per step on top of model latency — step-splitting is effectively free at pipeline granularity. `total_cost_usd` is an accounting signal under subscription auth, not an invoice; log it anyway.

### 6. Session Store  *(new component)*
**What:** Object storage (or volume) holding SDK session JSONL files for (a) Master conversations and (b) steps suspended on `ask_human`.
**Connects to:** Written by workers on suspend and by the Master service after each turn; restored by workers on resume — to `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` with the identical cwd. Validated: restore + resume in a fresh container works and keeps the **same session id**; a cwd mismatch fails fast at $0 cost. The fleet-wide canonical cwd `/work` makes this a copy-paste operation.
**Constraints:**
- The JSONL format is internal to the SDK: stored and restored as an opaque blob, **never parsed**. All UI reads come from the Status DB mirror.
- Completed (non-suspended) steps need no session persistence — the branch is their memory. The store holds only live chats and open suspensions.

### 7. GitHub / Branch
Unchanged: source of truth for issues, code, PRs; branch-per-run; artifacts under `pipeline/`; the only context handoff between steps.

### 8. Status DB
Unchanged in role — single source of truth for runs, steps, questions — with two additions:
- **Chat mirror tables** (conversations, messages) powering the Master chat UI.
- **Per-step cost** (`total_cost_usd` from each SDK result), summed per run.

### 9. Human-in-the-loop (`ask_human`)
Unchanged design; now fully concrete:
1. Step's `ask_human` tool (custom in-process MCP — the SDK has no headless ask-user) writes the Question row, fires the notification, returns a suspend sentinel; the worker persists the JSONL, emits `step.waiting_human`, and exits.
2. Runner `waitForEvent("question.answered")` — nothing runs, nothing costs.
3. Answer arrives from board or Master chat (`answer_question` tool) → stored → event emitted.
4. Runner provisions a fresh worker that restores the JSONL and resumes the session with the answer; the agent continues mid-step with full prior context.
- Ask cap enforced in the tool implementation (count in Status DB).

### 10. Board / Dashboard + Notifications
Unchanged: read-only projections of the Status DB; notifications fired by the runner on `run-completed`, `run-failed`, `waiting-human`.

---

## Deployment decisions (all locked)

- **Worker substrate: Docker on the factory VM.** Validated end-to-end 2026-08-27 (subscription OAuth via env var in an isolated container; cross-container session resume; negative controls clean). Full project runs on one VM: control plane, Inngest, Postgres on the host; workers as containers; one-time `setup-token`.
- **Inngest: self-hosted on the VM.** One more container beside Postgres. Events (repo names, briefs) never leave the VM.
- **Notifications: in-app only (v1).** The runner writes Notification rows to the Status DB on `run-completed`, `run-failed`, `waiting-human`; the UI surfaces them (notification center + badge) over SSE/WebSocket. Human input (`ask_human` answers) happens in the UI or Master chat. External channels (Telegram/Slack/email) are a later version — the runner's notify call is a thin adapter so adding a channel touches one module and no architecture.
- **Step logs: Postgres table.** Workers append tool-call events to `step_logs` as they stream; the live viewer reads via LISTEN/NOTIFY or polling. `StepRun.logRef` = the step's row range.

**Standing policy (not a decision):** subscription rate limits vs throughput — parallel pipelines can exhaust 5-hour/weekly caps; the runner treats rate-limit errors as retryable-with-backoff; sustained heavy use may eventually justify API billing.

---

## The rule, restated for the new boxes

State lives outside processes — now at four levels: a fresh Master chat rebuilds from the Status DB; a new step session rebuilds from the branch; a suspended step rebuilds from the Session Store; a restarted runner rebuilds from Inngest's durable execution log. No box holds state that dies with it.
