-- AI Factory domain model (spec §4). One migration for the full v1 schema.

-- Operator settings (tokens, repo). Token rotation = update the row, no restart.
create table settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Pipeline definitions are data. Steps live in the `steps` jsonb array
-- (StepDefinition[] from the spec); the runner reads whole definitions,
-- never individual steps relationally. Never hard-deleted — runs reference them.
create table pipeline_definitions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  description  text not null,
  input_schema jsonb not null default '{}'::jsonb,
  steps        jsonb not null default '[]'::jsonb,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- definition_snapshot: the definition as it was at spawn time. The runner
-- executes the snapshot so editing a pipeline never changes in-flight runs.
create table pipeline_runs (
  id                  uuid primary key default gen_random_uuid(),
  pipeline_id         uuid not null references pipeline_definitions(id),
  pipeline_name       text not null,
  definition_snapshot jsonb not null,
  issue_number        integer,
  branch              text not null,
  brief               text not null,
  status              text not null default 'running'
    check (status in ('running','waiting-human','failed','completed','cancelled')),
  current_step_index  integer not null default 0,
  created_by          text not null
    check (created_by in ('chat','webhook','schedule','api')),
  idempotency_key     text unique,
  cost_usd            numeric(12,6),
  created_at          timestamptz not null default now(),
  ended_at            timestamptz
);
create index pipeline_runs_status_idx on pipeline_runs (status);
create index pipeline_runs_issue_idx on pipeline_runs (issue_number);

create table step_runs (
  id                        uuid primary key default gen_random_uuid(),
  pipeline_run_id           uuid not null references pipeline_runs(id) on delete cascade,
  step_index                integer not null,
  attempt                   integer not null default 1,
  status                    text not null default 'pending'
    check (status in ('pending','running','waiting-human','validating','done','failed')),
  harness_session_id        text,
  verdict                   jsonb,
  ask_human_count           integer not null default 0,
  commit_shas               jsonb not null default '[]'::jsonb,
  cost_usd                  numeric(12,6),
  log_ref                   text,
  container_id              text,
  -- Internal-plane auth: per-step scoped token (hashed), expires when the step ends.
  internal_token_hash       text,
  internal_token_expires_at timestamptz,
  started_at                timestamptz,
  ended_at                  timestamptz,
  created_at                timestamptz not null default now(),
  unique (pipeline_run_id, step_index, attempt)
);
create index step_runs_run_idx on step_runs (pipeline_run_id);

create table questions (
  id              uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid not null references pipeline_runs(id) on delete cascade,
  step_run_id     uuid not null references step_runs(id) on delete cascade,
  kind            text not null check (kind in ('text','multiple-choice')),
  body            text not null,
  choices         jsonb,
  answer          text,
  status          text not null default 'open' check (status in ('open','answered')),
  created_at      timestamptz not null default now(),
  answered_at     timestamptz
);
create index questions_status_idx on questions (status);

-- Projection of GitHub. Never edited except from GitHub data.
create table issue_cache (
  number        integer primary key,
  title         text not null,
  board_status  text not null default 'backlog'
    check (board_status in ('backlog','in-progress','needs-review','completed','blocked')),
  blocked_by    jsonb not null default '[]'::jsonb,
  active_run_id uuid references pipeline_runs(id),
  linked_pr     text,
  raw           jsonb,
  synced_at     timestamptz not null default now()
);

-- 'factory-health' is for substrate problems (e.g. worker auth failure),
-- which the architecture routes to a notification, never a step retry.
create table notifications (
  id              uuid primary key default gen_random_uuid(),
  event           text not null
    check (event in ('run-completed','run-failed','waiting-human','factory-health')),
  pipeline_run_id uuid references pipeline_runs(id),
  question_id     uuid references questions(id),
  summary         text not null,
  read            boolean not null default false,
  created_at      timestamptz not null default now()
);
create index notifications_unread_idx on notifications (read, created_at);

-- Tool-call stream per step. StepRun.log_ref = this table's row range.
create table step_logs (
  id          bigserial primary key,
  step_run_id uuid not null references step_runs(id) on delete cascade,
  event       jsonb not null,
  ts          timestamptz not null default now()
);
create index step_logs_step_idx on step_logs (step_run_id, id);

-- Live log tail (LISTEN/NOTIFY) for the session viewer.
create function notify_step_log() returns trigger as $$
begin
  perform pg_notify('step_logs',
    json_build_object('stepRunId', new.step_run_id, 'id', new.id)::text);
  return new;
end $$ language plpgsql;

create trigger step_logs_notify
  after insert on step_logs
  for each row execute function notify_step_log();

-- Chat mirror: powers chat history UI. Session JSONL is never parsed.
create table chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  sdk_session_id  text,
  title           text not null default 'New conversation',
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  role            text not null,
  content         text not null,
  ts              timestamptz not null default now()
);
create index chat_messages_conv_idx on chat_messages (conversation_id, ts);

-- Webhook + schedule triggers. `mapping` maps payload fields to
-- {pipeline, issueNumber, brief}; `schedule` is a cron expression (null = webhook-only).
create table triggers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  pipeline    text not null,
  mapping     jsonb not null default '{}'::jsonb,
  hmac_secret text not null,
  schedule    text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table trigger_fires (
  id          uuid primary key default gen_random_uuid(),
  trigger_id  uuid not null references triggers(id) on delete cascade,
  delivery_id text,
  run_id      uuid references pipeline_runs(id),
  outcome     text not null,
  fired_at    timestamptz not null default now()
);
create unique index trigger_fires_delivery_idx
  on trigger_fires (trigger_id, delivery_id) where delivery_id is not null;
