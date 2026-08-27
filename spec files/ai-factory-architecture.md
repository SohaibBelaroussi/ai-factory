# AI Factory — High-Level Architecture

Only what has been agreed. Each component: what it is, what it connects to, and its constraints.

---

## Diagram

```
                 ┌──────────────────────────────────────────────┐
                 │                   HUMAN                      │
                 │        chat ↔ Master · board/dashboard       │
                 └───────┬──────────────────────────▲───────────┘
                         │ messages / answers       │ status, notifications,
                         │                          │ pending questions
  TRIGGERS               ▼                          │
 ┌──────────────┐   ┌─────────────────────────┐     │
 │ user chat    │──▶│      MASTER AGENT       │     │
 │ github       │──▶│  chat LLM (judgment)    │     │
 │ actions      │   │  + tools (all code):    │     │
 │ schedule     │──▶│  read: board, issues,   │◀────┼──────────────┐
 └──────────────┘   │   runs, artifacts,      │     │              │
                    │   questions             │     │              │ status
                    │  write: spawn_pipeline, │     │              │ (reads)
                    │   answer_question       │     │              │
                    └───────────┬─────────────┘     │              │
                                │ spawn(type, brief)│              │
                                ▼                   │              │
   PIPELINE            ┌─────────────────────────┐  │       ┌───────────────┐
   DEFINITIONS  ──────▶│    PIPELINE RUNNER      │──┼──────▶│   STATUS DB   │
   (data: steps,       │    (generic, code)      │  │       │ runs · steps  │
   prompts, tools)     │  step 1 → 2 → … → N     │  │       │ questions     │
                       └───────────┬─────────────┘  │       └───────┬───────┘
                                   │ one session    │               │ projection
                                   ▼ per step       │               ▼
                       ┌─────────────────────────┐  │       ┌───────────────┐
                       │      STEP SESSION       │  │       │    BOARD /    │
                       │  (ephemeral harness,    │──┘       │   DASHBOARD   │
                       │   full agent, scoped    │ ask_human │ + notifications│
                       │   tools)                │ (suspend) └───────────────┘
                       └───────────┬─────────────┘
                                   │ commits + artifacts (only survivors)
                                   ▼
                       ┌─────────────────────────┐
                       │    GITHUB / BRANCH      │
                       │ issues · code · PRs ·   │
                       │ pipeline/ artifacts     │
                       └─────────────────────────┘
```

---

## Components

### 1. Triggers
**What:** Entry points that wake the system: user chat message, GitHub Actions/webhook, schedule.
**Connects to:** All converge on the Master agent (chat) or directly on `spawn_pipeline` (well-defined webhook/cron mappings).
**Constraints:**
- A trigger only starts work; it holds no state and makes no decisions beyond its mapping.

### 2. Master Agent
**What:** Chat LLM (conversation + judgment) plus a set of deterministic tools (dispatch + status).
**Connects to:** Reads Status DB and GitHub through tools; writes only via `spawn_pipeline`, `answer_question`, issue/board updates. Talks to the human in chat.
**Constraints:**
- Judgment in the LLM, bookkeeping in code: every derived fact (blocked?, already running?) is computed inside a tool, never reasoned out by the LLM.
- Holds no project state: chat context is per-conversation; a fresh chat reconstructs reality by reading state.
- Sees summaries and states only — never session transcripts, raw diffs, or secrets.
- Picks pipelines by reading pipeline descriptions (descriptions are prompt text).
- Never does pipeline work itself (no planning/implementing/reviewing).

### 3. Pipeline Definitions
**What:** Pipelines as data: name, description, ordered steps; per step a static behavior prompt, model, allowed-tools list, expected output artifact.
**Connects to:** Created/edited in the UI; read by the Master (to choose) and by the Runner (to execute).
**Constraints:**
- Adding a pipeline type requires zero engine changes — data only.
- Steps are linear; the only loop is retry-with-feedback (capped).
- Behavior prompts are static — no variables; dynamic context arrives at runtime (see Step Session).
- `ask_human` is just an entry in a step's allowed-tools list: gated vs autonomous pipelines are the same machinery, one grant apart.

### 4. Pipeline Runner
**What:** One generic executor, pure code, no LLM. Runs any pipeline definition: spawn step session → wait → validate output → next step.
**Connects to:** Reads Pipeline Definitions; provisions/destroys Step Sessions; writes every state change to the Status DB; fires notifications.
**Constraints:**
- Deterministic: all routing between steps comes from parsed verdicts + definition rules, never from an LLM call.
- Validates every step's output contract (declared artifact exists, verdict parses); a step that fails the contract fails the run.
- Pausing = not spawning the next thing. Nothing runs and nothing costs money while a run waits.

### 5. Step Session
**What:** One ephemeral harness run (Claude Code / opencode) per step — a full agent with a goal: it can read the repo, search the web, use its granted tools.
**Connects to:** Clones the run's branch from GitHub; receives its prompt from the Runner; persists work as commits + artifacts; may call `ask_human`.
**Constraints:**
- Ephemeral: born empty, destroyed always (success or failure). Only commits, artifacts, and the persisted log survive.
- Prompt = three layers: harness prompt (global, operator-written) + behavior prompt (human, static) + runtime context (runner-assembled: brief, pointers, previous verdict).
- Context by reference: gets pointers to artifacts, reads what it needs itself — nothing pasted wholesale.
- Scoped tools, default deny.
- Must end with a structured verdict (status + one-line summary) — this is what feeds the board.
- Sessions split where fresh context is a feature (review, gates); merge where continuity is the feature (plan+implement).

### 6. GitHub / Branch
**What:** Source of truth for issues, code, PRs — and the pipeline's memory: branch per issue, artifacts under `pipeline/`.
**Connects to:** Cloned by every Step Session; read by the Master's tools; PRs reviewed by the human.
**Constraints:**
- The branch is the only context handoff between steps: a step inherits the previous step's conclusions (artifacts), never its context window.
- Issues carry dependencies (blocked-by); satisfaction is computed by code.

### 7. Status DB
**What:** Single source of truth for pipeline runs, step states, and open human questions.
**Connects to:** Written only by the Runner (and Master write tools); read by Master tools, board/dashboard, notifications.
**Constraints:**
- Board and dashboard are read-only projections of this DB — no separate state, no new write paths.
- Every run/step carries a one-line summary written at the source (the verdict), so projections are cheap.

### 8. Human-in-the-loop (`ask_human`)
**What:** A tool available inside a step (if granted). Agent asks, human answers, agent continues mid-step.
**Connects to:** Creates a Question in the Status DB, fires a notification; answered from the board **or** from Master chat; Runner resumes the session by id.
**Constraints:**
- Suspend/resume, never a blocked process: on ask, the session process ends; the resumable transcript persists; answering hours later is identical to seconds later.
- Capped per step to prevent ask-loops.

### 9. Board / Dashboard + Notifications
**What:** The human's read surface: issue columns (backlog / in-progress / needs-review / completed / blocked), run progress, pending questions. Notifications fire on run completed, run failed, and waiting-human.
**Connects to:** Projects the Status DB; question-answering writes back through the same path as chat.
**Constraints:**
- Read-only projection + answer box. All state changes flow through the Runner / Master tools.

---

## The one rule that repeats at every level

State lives outside processes. A fresh Master chat rebuilds from the Status DB and GitHub. A new step session rebuilds from the branch. Nothing important ever lives only in a context window or a container.
