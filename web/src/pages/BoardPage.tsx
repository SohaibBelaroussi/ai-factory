import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getBoard } from '../lib/api';
import type { BoardRow } from '../lib/types';
import { DispatchDialog } from '../components/DispatchDialog';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';

const COLUMNS: { key: string; title: string; accent: string }[] = [
  { key: 'backlog', title: 'Backlog', accent: 'border-faint' },
  { key: 'blocked', title: 'Blocked', accent: 'border-err' },
  { key: 'in-progress', title: 'In progress', accent: 'border-accent' },
  { key: 'needs-review', title: 'Needs review', accent: 'border-warn' },
  { key: 'completed', title: 'Completed', accent: 'border-ok' },
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
    <div className="group rounded-md border border-border bg-panel-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/issues/${issue.number}`} className="text-sm font-medium hover:text-accent">
          <span className="text-dim">#{issue.number}</span> {issue.title}
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {issue.blockedBy.length > 0 && (
          <span className="text-err" title="unmet dependencies">
            ⛓ {issue.blockedBy.map((n) => `#${n}`).join(' ')}
          </span>
        )}
        {issue.activeRunId && (
          <Link to={`/runs/${issue.activeRunId}`} className="text-accent hover:underline">
            active run →
          </Link>
        )}
        {issue.linkedPr && (
          <a
            href={issue.linkedPr}
            target="_blank"
            rel="noreferrer"
            className="text-warn hover:underline"
          >
            PR ↗
          </a>
        )}
        {dispatchable && (
          <button
            onClick={() => onDispatch(issue.number)}
            className="ml-auto rounded bg-accent-dim px-2 py-0.5 font-medium opacity-0 transition-opacity group-hover:opacity-100"
          >
            run ▸
          </button>
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
  // Anything with an unknown status still deserves a column.
  const extraStatuses = [...byStatus.keys()].filter((s) => !COLUMNS.some((c) => c.key === s));

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Board">
        <button
          onClick={() => setDialog({})}
          className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          + dispatch
        </button>
      </PageHeader>

      {board.isLoading && (
        <div className="p-6">
          <Spinner />
        </div>
      )}
      {board.isError && <ErrorNote error={board.error} />}
      {board.data?.length === 0 && <Empty>no issues in the cache yet — sync runs on read</Empty>}

      {board.data && board.data.length > 0 && (
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-6">
          {[...COLUMNS, ...extraStatuses.map((s) => ({ key: s, title: s, accent: 'border-faint' }))].map(
            (col) => {
              const items = byStatus.get(col.key) ?? [];
              return (
                <div key={col.key} className="flex w-64 shrink-0 flex-col">
                  <div
                    className={`mb-2 flex items-center justify-between border-b-2 ${col.accent} pb-1.5`}
                  >
                    <span className="text-sm font-semibold">{col.title}</span>
                    <span className="text-xs text-dim">{items.length}</span>
                  </div>
                  <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                    {items.map((issue) => (
                      <IssueCard
                        key={issue.number}
                        issue={issue}
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
