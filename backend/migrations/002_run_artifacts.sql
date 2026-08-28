-- Archive of pipeline/ artifacts per run, captured at run end. The branch
-- carries artifacts only while the run lives; the PR diff stays clean and the
-- audit trail outlives the branch.
create table run_artifacts (
  id              uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid not null references pipeline_runs(id) on delete cascade,
  name            text not null,
  content         text not null,
  archived_at     timestamptz not null default now(),
  unique (pipeline_run_id, name)
);
