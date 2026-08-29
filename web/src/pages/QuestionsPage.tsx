import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { listNotifications, listQuestions, markNotificationsRead } from '../lib/api';
import { shortId, timeAgo } from '../lib/format';
import { QuestionCard } from '../components/QuestionCard';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { cn } from '@/lib/utils';

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
      <PageHeader title="Inbox">
        {unreadCount > 0 && (
          <Button
            disabled={markAll.isPending}
            onClick={() => markAll.mutate()}
            size="sm"
            variant="outline"
          >
            mark all read ({unreadCount})
          </Button>
        )}
      </PageHeader>

      <div className="mx-auto grid max-w-4xl gap-8 p-8 pt-6">
        <section>
          <h2 className="font-display mb-3 text-base">
            Pending questions{open.data && open.data.length > 0 ? ` (${open.data.length})` : ''}
          </h2>
          {open.isLoading && <Spinner />}
          {open.isError && <ErrorNote error={open.error} />}
          {open.data?.length === 0 && (
            <Card>
              <Empty>nothing is waiting on you — runs proceed on their own</Empty>
            </Card>
          )}
          <div className="grid gap-3">
            {open.data?.map((q) => (
              <QuestionCard
                context={
                  <span>
                    ·{' '}
                    <Link className="text-primary hover:underline" to={`/runs/${q.pipeline_run_id}`}>
                      {q.pipeline_name} {shortId(q.pipeline_run_id)}
                    </Link>
                    {q.issue_number !== null && (
                      <>
                        {' · '}
                        <Link className="text-primary hover:underline" to={`/issues/${q.issue_number}`}>
                          #{q.issue_number}
                        </Link>
                      </>
                    )}
                  </span>
                }
                key={q.id}
                question={q}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="font-display mb-3 text-base">Notifications</h2>
          {notifications.isLoading && <Spinner />}
          {notifications.isError && <ErrorNote error={notifications.error} />}
          {notifications.data?.length === 0 && (
            <Card>
              <Empty>no notifications yet</Empty>
            </Card>
          )}
          {notifications.data && notifications.data.length > 0 && (
            <Card className="gap-0 py-0">
              <ul className="divide-y divide-border">
                {notifications.data.map((n) => (
                  <li
                    className={cn('flex items-start gap-3 px-5 py-3', n.read && 'opacity-50')}
                    key={n.id}
                  >
                    <span className="mt-0.5">{EVENT_ICON[n.event] ?? '•'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{n.summary}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-muted-foreground/70 text-xs">
                        <span>{n.event}</span>
                        <span>· {timeAgo(n.created_at)}</span>
                        {n.pipeline_run_id && (
                          <Link
                            className="text-primary hover:underline"
                            to={`/runs/${n.pipeline_run_id}`}
                          >
                            run {shortId(n.pipeline_run_id)}
                          </Link>
                        )}
                      </div>
                    </div>
                    {!n.read && (
                      <button
                        className="shrink-0 text-muted-foreground text-xs hover:text-foreground"
                        onClick={() => markOne.mutate(n.id)}
                        title="mark read"
                      >
                        ✓
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
