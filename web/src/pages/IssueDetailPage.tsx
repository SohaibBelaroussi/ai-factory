import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ExternalLinkIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getIssue } from '../lib/api';
import { shortId, timeAgo } from '../lib/format';
import { DispatchDialog } from '../components/DispatchDialog';
import { ErrorNote, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { cn } from '@/lib/utils';

export default function IssueDetailPage(): React.ReactNode {
  const { n } = useParams<{ n: string }>();
  const number = Number(n);
  const issue = useQuery({
    queryKey: ['issue', number],
    queryFn: () => getIssue(number),
    enabled: Number.isInteger(number) && number > 0,
  });
  const [dialog, setDialog] = useState(false);

  if (issue.isLoading)
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  if (issue.isError) return <ErrorNote error={issue.error} />;
  if (!issue.data) return null;
  const d = issue.data;

  return (
    <div>
      <PageHeader
        title={
          <span>
            <span className="text-muted-foreground">#{d.number}</span> {d.title}
          </span>
        }
      >
        <StatusBadge status={d.boardStatus} />
        <Button onClick={() => setDialog(true)} size="sm">
          + dispatch
        </Button>
      </PageHeader>

      <div className="mx-auto grid max-w-4xl gap-6 p-8 pt-6">
        <Card>
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span>github: {d.state}</span>
              {d.labels.map((l) => (
                <Badge key={l} variant="secondary">
                  {l}
                </Badge>
              ))}
              {d.linkedBranch && <span className="font-mono">⎇ {d.linkedBranch}</span>}
              {d.linkedPr && (
                <a
                  className="inline-flex items-center gap-1 text-amber-700 hover:underline dark:text-amber-400"
                  href={d.linkedPr}
                  rel="noreferrer"
                  target="_blank"
                >
                  PR <ExternalLinkIcon className="size-3" />
                </a>
              )}
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm">{d.body || '(no body)'}</pre>
          </CardContent>
        </Card>

        {d.dependencies.blockedBy.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-base">Dependencies</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {d.dependencies.blockedBy.map((dep) => {
                const ok = d.dependencies.satisfied.includes(dep);
                return (
                  <Link
                    className={cn(
                      'rounded-lg px-2.5 py-1 text-sm',
                      ok
                        ? 'bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
                        : 'bg-red-600/10 text-red-700 dark:bg-red-400/10 dark:text-red-300',
                    )}
                    key={dep}
                    to={`/issues/${dep}`}
                  >
                    #{dep} {ok ? '✓' : '✗'}
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        )}

        {d.pastRuns.length > 0 && (
          <Card className="gap-0 py-0">
            <CardHeader className="border-b border-border py-4">
              <CardTitle className="font-display text-base">Runs</CardTitle>
            </CardHeader>
            <ul className="divide-y divide-border">
              {d.pastRuns.map((run) => (
                <li className="flex items-center gap-3 px-5 py-3 text-sm" key={run.id}>
                  <Link className="font-mono text-primary hover:underline" to={`/runs/${run.id}`}>
                    {shortId(run.id)}
                  </Link>
                  <StatusBadge status={run.status} />
                  <span className="text-muted-foreground">{run.pipeline}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={run.outcome ?? ''}>
                    {run.outcome ?? ''}
                  </span>
                  <span className="whitespace-nowrap text-muted-foreground/60 text-xs">
                    {timeAgo(run.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {d.comments.length > 0 && (
          <Card className="gap-0 py-0">
            <CardHeader className="border-b border-border py-4">
              <CardTitle className="font-display text-base">Comments ({d.comments.length})</CardTitle>
            </CardHeader>
            <ul className="divide-y divide-border">
              {d.comments.map((c, i) => (
                <li className="px-5 py-4" key={i}>
                  <div className="mb-1 font-medium text-muted-foreground text-xs">{c.author}</div>
                  <pre className="whitespace-pre-wrap font-sans text-sm">{c.body}</pre>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {dialog && <DispatchDialog issueNumber={d.number} onClose={() => setDialog(false)} />}
    </div>
  );
}
