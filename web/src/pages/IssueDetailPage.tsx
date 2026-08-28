import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { getIssue } from '../lib/api';
import { shortId, timeAgo } from '../lib/format';
import { DispatchDialog } from '../components/DispatchDialog';
import { ErrorNote, PageHeader, Panel, Spinner, StatusBadge } from '../components/ui';

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
      <div className="p-6">
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
            <span className="text-dim">#{d.number}</span> {d.title}
          </span>
        }
      >
        <StatusBadge status={d.boardStatus} />
        <button
          onClick={() => setDialog(true)}
          className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          + dispatch
        </button>
      </PageHeader>

      <div className="grid max-w-4xl gap-6 p-6">
        <Panel className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-dim">
            <span>github: {d.state}</span>
            {d.labels.map((l) => (
              <span key={l} className="rounded-full bg-panel-2 px-2 py-0.5">
                {l}
              </span>
            ))}
            {d.linkedBranch && <span className="font-mono">⎇ {d.linkedBranch}</span>}
            {d.linkedPr && (
              <a href={d.linkedPr} target="_blank" rel="noreferrer" className="text-warn hover:underline">
                PR ↗
              </a>
            )}
          </div>
          <pre className="font-sans whitespace-pre-wrap text-sm text-ink">{d.body || '(no body)'}</pre>
        </Panel>

        {d.dependencies.blockedBy.length > 0 && (
          <Panel className="p-4">
            <div className="mb-2 text-sm font-semibold">Dependencies</div>
            <div className="flex flex-wrap gap-2 text-sm">
              {d.dependencies.blockedBy.map((dep) => {
                const ok = d.dependencies.satisfied.includes(dep);
                return (
                  <Link
                    key={dep}
                    to={`/issues/${dep}`}
                    className={`rounded-md px-2 py-1 ${ok ? 'bg-ok/15 text-ok' : 'bg-err/15 text-err'}`}
                  >
                    #{dep} {ok ? '✓' : '✗'}
                  </Link>
                );
              })}
            </div>
          </Panel>
        )}

        {d.pastRuns.length > 0 && (
          <Panel>
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">Runs</div>
            <ul className="divide-y divide-border/50">
              {d.pastRuns.map((run) => (
                <li key={run.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Link to={`/runs/${run.id}`} className="font-mono text-accent hover:underline">
                    {shortId(run.id)}
                  </Link>
                  <StatusBadge status={run.status} />
                  <span className="text-dim">{run.pipeline}</span>
                  <span className="min-w-0 flex-1 truncate text-dim" title={run.outcome ?? ''}>
                    {run.outcome ?? ''}
                  </span>
                  <span className="whitespace-nowrap text-xs text-faint">{timeAgo(run.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {d.comments.length > 0 && (
          <Panel>
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">
              Comments ({d.comments.length})
            </div>
            <ul className="divide-y divide-border/50">
              {d.comments.map((c, i) => (
                <li key={i} className="px-4 py-3">
                  <div className="mb-1 text-xs font-medium text-dim">{c.author}</div>
                  <pre className="font-sans whitespace-pre-wrap text-sm">{c.body}</pre>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {dialog && <DispatchDialog issueNumber={d.number} onClose={() => setDialog(false)} />}
    </div>
  );
}
