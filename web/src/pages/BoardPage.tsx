import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLinkIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getBoard } from '../lib/api';
import type { BoardRow } from '../lib/types';
import { DispatchDialog } from '../components/DispatchDialog';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { cn } from '@/lib/utils';

const COLUMNS: { key: string; title: string; accent: string }[] = [
  { key: 'backlog', title: 'Backlog', accent: 'bg-neutral-400' },
  { key: 'blocked', title: 'Blocked', accent: 'bg-red-500' },
  { key: 'in-progress', title: 'In progress', accent: 'bg-blue-500' },
  { key: 'needs-review', title: 'Needs review', accent: 'bg-amber-500' },
  { key: 'completed', title: 'Completed', accent: 'bg-emerald-500' },
];

function IssueCard({
  issue,
  onDispatch,
}: {
  issue: BoardRow;
  onDispatch: (n: number) => void;
}): React.ReactNode {
  const dispatchable = issue.boardStatus === 'backlog' || issue.boardStatus === 'blocked';
  return (
    <div className="group rounded-xl border border-border bg-card p-3 shadow-xs transition-shadow hover:shadow-sm">
      <Link className="text-sm hover:text-primary" to={`/issues/${issue.number}`}>
        <span className="text-muted-foreground">#{issue.number}</span>{' '}
        <span className="font-medium">{issue.title}</span>
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {issue.blockedBy.length > 0 && (
          <span className="text-red-600 dark:text-red-400" title="unmet dependencies">
            ⛓ {issue.blockedBy.map((n) => `#${n}`).join(' ')}
          </span>
        )}
        {issue.activeRunId && (
          <Link className="text-primary hover:underline" to={`/runs/${issue.activeRunId}`}>
            active run →
          </Link>
        )}
        {issue.linkedPr && (
          <a
            className="inline-flex items-center gap-1 text-amber-700 hover:underline dark:text-amber-400"
            href={issue.linkedPr}
            rel="noreferrer"
            target="_blank"
          >
            PR <ExternalLinkIcon className="size-3" />
          </a>
        )}
        {dispatchable && (
          <Button
            className="ml-auto h-6 gap-1 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => onDispatch(issue.number)}
            size="sm"
            variant="secondary"
          >
            <PlayIcon className="size-3" /> run
          </Button>
        )}
      </div>
    </div>
  );
}

export default function BoardPage(): React.ReactNode {
  const board = useQuery({ queryKey: ['board'], queryFn: getBoard });
  const [dialog, setDialog] = useState<{ issueNumber?: number } | null>(null);

  const byStatus = new Map<string, BoardRow[]>();
  for (const row of board.data ?? []) {
    const list = byStatus.get(row.boardStatus) ?? [];
    list.push(row);
    byStatus.set(row.boardStatus, list);
  }
  const extraStatuses = [...byStatus.keys()].filter((s) => !COLUMNS.some((c) => c.key === s));

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Board">
        <Button onClick={() => setDialog({})} size="sm">
          + dispatch
        </Button>
      </PageHeader>

      {board.isLoading && (
        <div className="p-8">
          <Spinner />
        </div>
      )}
      {board.isError && <ErrorNote error={board.error} />}
      {board.data?.length === 0 && <Empty>no issues in the cache yet — sync runs on read</Empty>}

      {board.data && board.data.length > 0 && (
        <div className="flex min-h-0 flex-1 gap-5 overflow-x-auto p-8 pt-6">
          {[...COLUMNS, ...extraStatuses.map((s) => ({ key: s, title: s, accent: 'bg-neutral-400' }))].map(
            (col) => {
              const items = byStatus.get(col.key) ?? [];
              return (
                <div className="flex w-72 shrink-0 flex-col" key={col.key}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className={cn('size-2 rounded-full', col.accent)} />
                    <span className="font-display text-sm">{col.title}</span>
                    <span className="text-muted-foreground text-xs">{items.length}</span>
                  </div>
                  <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pb-4">
                    {items.map((issue) => (
                      <IssueCard
                        issue={issue}
                        key={issue.number}
                        onDispatch={(n) => setDialog({ issueNumber: n })}
                      />
                    ))}
                  </div>
                </div>
              );
            },
          )}
        </div>
      )}

      {dialog && <DispatchDialog issueNumber={dialog.issueNumber} onClose={() => setDialog(null)} />}
    </div>
  );
}
