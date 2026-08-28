# AI Factory — working notes for Claude

Read these before changing anything:

1. **[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)** — authoritative record
   of everything built (phases 0–4 complete + hardened), how it works, API
   surface, deviations, gotchas, and what Phase 5 (frontend — the only
   remaining phase) must build.
2. **[spec files/](spec%20files/)** — the product spec and locked architecture.
   Build exactly that system; IMPLEMENTATION.md records where and why reality
   deviates.

Invariants that must never break: ephemeral step sessions (nothing survives a
worker but commits, artifacts, logs, events); judgment in LLMs, bookkeeping in
code; pipelines are data (zero engine changes to add one); context passes by
reference over the branch; every step output contract-checked in code;
waiting-human = zero processes, zero spend; the Master only acts through its
factory tools; one code path per action (API route = Master tool = webhook).

Operational facts: stack runs via `docker compose up -d --build` (+ `--profile
tools` for the worker image); backend :3000, Inngest dashboard :8288; secrets
live in the settings table (PUT /settings/...), never in files; inngest SDK
stays on v3 LTS; the Agent SDK version is pinned exact in both package.jsons.
Commit at every milestone (Co-Authored-By trailer), push to origin main.
Humans merge PRs — the factory only opens them.
