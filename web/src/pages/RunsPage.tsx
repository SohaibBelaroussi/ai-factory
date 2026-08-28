import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listRuns } from '../lib/api';
import { cost, duration, shortId, timeAgo } from '../lib/format';
import { DispatchDialog } from '../components/DispatchDialog';
import { Empty, ErrorNote, PageHeader, Spinner, StatusBadge } from '../components/ui';

export default function RunsPage(): React.ReactNode {
  const [activeOnly, setActiveOnly] = useState(false);
  const [dialog, setDialog] = useState(false);
  const runs = useQuery({
    queryKey: ['runs', { activeOnly }],
    queryFn: () => listRuns({ active: activeOnly, limit: 100 }),
  });

  return (
    <div>
      <PageHeader title="Runs">
        <label className="flex items-center gap-1.5 text-xs text-dim">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          active only
        </label>
        <button
          onClick={() => setDialog(true)}
          className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          + dispatch
        </button>
      </PageHeader>

      {runs.isLoading && (
        <div className="p-6">
          <Spinner />
        </div>
      )}
      {runs.isError && <ErrorNote error={runs.error} />}
      {runs.data?.length === 0 && <Empty>no runs {activeOnly ? 'active' : 'yet'}</Empty>}

      {runs.data && runs.data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-dim">
              <th className="px-4 py-2 font-medium">run</th>
              <th className="px-4 py-2 font-medium">status</th>
              <th className="px-4 py-2 font-medium">pipeline</th>
              <th className="px-4 py-2 font-medium">issue</th>
              <th className="px-4 py-2 font-medium">step</th>
              <th className="px-4 py-2 font-medium">latest</th>
              <th className="px-4 py-2 font-medium">started</th>
              <th className="px-4 py-2 font-medium">took</th>
              <th className="px-4 py-2 font-medium">cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((run) => (
              <tr key={run.id} className="border-b border-border/50 hover:bg-panel">
                <td className="px-4 py-2.5">
                  <Link to={`/runs/${run.id}`} className="font-mono text-accent hover:underline">
                    {shortId(run.id)}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={run.status} />
                </td>
                <td className="px-4 py-2.5">{run.pipeline}</td>
                <td className="px-4 py-2.5">
                  {run.issueNumber !== null ? (
                    <Link to={`/issues/${run.issueNumber}`} className="text-accent hover:underline">
                      #{run.issueNumber}
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-dim">{run.currentStep}</td>
                <td className="max-w-64 truncate px-4 py-2.5 text-dim">
                  {run.pendingQuestion ? (
                    <span className="text-warn" title={run.pendingQuestion}>
                      ❓ {run.pendingQuestion}
                    </span>
                  ) : (
                    <span title={run.lastVerdictSummary ?? ''}>{run.lastVerdictSummary ?? '—'}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-dim">{timeAgo(run.startedAt)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-dim">
                  {duration(run.startedAt, run.endedAt)}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-dim">{cost(run.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dialog && <DispatchDialog onClose={() => setDialog(false)} />}
    </div>
  );
}
