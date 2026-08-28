-- /events SSE backing: domain-change notifications via LISTEN/NOTIFY.
-- Events carry ids, not payloads — clients re-fetch the resource (the GET is
-- the truth; avoids projection drift).

create function notify_factory_event() returns trigger as $$
declare
  evt json;
begin
  if tg_table_name = 'notifications' then
    evt := json_build_object('type', 'notification.created', 'id', new.id);
  elsif tg_table_name = 'questions' then
    evt := json_build_object('type', 'question.created', 'id', new.id);
  elsif tg_table_name = 'pipeline_runs' then
    evt := json_build_object('type', 'run.updated', 'id', new.id);
  elsif tg_table_name = 'step_runs' then
    evt := json_build_object('type', 'run.updated', 'id', new.pipeline_run_id);
  elsif tg_table_name = 'issue_cache' then
    evt := json_build_object('type', 'board.updated', 'number', new.number);
  end if;
  if evt is not null then
    perform pg_notify('factory_events', evt::text);
  end if;
  return new;
end $$ language plpgsql;

create trigger notifications_evt after insert on notifications
  for each row execute function notify_factory_event();
create trigger questions_evt after insert on questions
  for each row execute function notify_factory_event();
create trigger pipeline_runs_evt after insert or update on pipeline_runs
  for each row execute function notify_factory_event();
create trigger step_runs_evt after insert or update on step_runs
  for each row execute function notify_factory_event();
create trigger issue_cache_evt after insert or update on issue_cache
  for each row execute function notify_factory_event();
