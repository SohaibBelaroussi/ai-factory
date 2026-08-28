import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listNotifications, listQuestions, markNotificationsRead } from '../lib/api';
import { timeAgo } from '../lib/format';
import { shortId } from '../lib/format';
import { QuestionCard } from '../components/QuestionCard';
import { Empty, ErrorNote, PageHeader, Panel, Spinner } from '../components/ui';

const EVENT_ICON: Record<string, string> = {
  'waiting-human': '❓',
  'run-completed': '✅',
  'run-failed': '❌',
  'factory-health': '🏥',
};

export default function QuestionsPage(): React.ReactNode {
  const queryClient = useQueryClient();
  const open = useQuery({ queryKey: ['questions', 'open'], queryFn: () => listQuestions('open') });
  const notifications = useQuery({
    queryKey: ['notifications', 'all'],
    queryFn: () => listNotifications({ limit: 100 }),
  });
  const markAll = useMutation({
    mutationFn: () => markNotificationsRead({ all: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markOne = useMutation({
    mutationFn: (id: string) => markNotificationsRead({ ids: [id] }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unreadCount = notifications.data?.filter((n) => !n.read).length ?? 0;

  return (
    <div>
      <PageHeader title="Questions & Notifications">
        {unreadCount > 0 && (
          <button
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-40"
          >
            mark all read ({unreadCount})
          </button>
        )}
      </PageHeader>

      <div className="grid max-w-4xl gap-6 p-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-warn">
            Pending questions {open.data && open.data.length > 0 ? `(${open.data.length})` : ''}
          </h2>
          {open.isLoading && <Spinner />}
          {open.isError && <ErrorNote error={open.error} />}
          {open.data?.length === 0 && (
            <Panel>
              <Empty>nothing is waiting on you — runs proceed on their own</Empty>
            </Panel>
          )}
          <div className="grid gap-3">
            {open.data?.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                context={
                  <span>
                    ·{' '}
                    <Link to={`/runs/${q.pipeline_run_id}`} className="text-accent hover:underline">
                      {q.pipeline_name} {shortId(q.pipeline_run_id)}
                    </Link>
                    {q.issue_number !== null && (
                      <>
                        {' · '}
                        <Link to={`/issues/${q.issue_number}`} className="text-accent hover:underline">
                          #{q.issue_number}
                        </Link>
                      </>
                    )}
                  </span>
                }
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Notifications</h2>
          {notifications.isLoading && <Spinner />}
          {notifications.isError && <ErrorNote error={notifications.error} />}
          {notifications.data?.length === 0 && (
            <Panel>
              <Empty>no notifications yet</Empty>
            </Panel>
          )}
          {notifications.data && notifications.data.length > 0 && (
            <Panel>
              <ul className="divide-y divide-border/50">
                {notifications.data.map((n) => (
                  <li
                    key={n.id}
                    className={`flex items-start gap-3 px-4 py-2.5 ${n.read ? 'opacity-50' : ''}`}
                  >
                    <span className="mt-0.5">{EVENT_ICON[n.event] ?? '•'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{n.summary}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
                        <span>{n.event}</span>
                        <span>· {timeAgo(n.created_at)}</span>
                        {n.pipeline_run_id && (
                          <Link
                            to={`/runs/${n.pipeline_run_id}`}
                            className="text-accent hover:underline"
                          >
                            run {shortId(n.pipeline_run_id)}
                          </Link>
                        )}
                      </div>
                    </div>
                    {!n.read && (
                      <button
                        onClick={() => markOne.mutate(n.id)}
                        className="shrink-0 text-xs text-dim hover:text-ink"
                        title="mark read"
                      >
                        ✓
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </section>
      </div>
    </div>
  );
}
