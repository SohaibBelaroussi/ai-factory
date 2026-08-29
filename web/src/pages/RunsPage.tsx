import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
        <label className="mr-2 flex items-center gap-2 text-muted-foreground text-sm">
          <Switch checked={activeOnly} onCheckedChange={setActiveOnly} />
          active only
        </label>
        <Button onClick={() => setDialog(true)} size="sm">
          + dispatch
        </Button>
      </PageHeader>

      {runs.isLoading && (
        <div className="p-8">
          <Spinner />
        </div>
      )}
      {runs.isError && <ErrorNote error={runs.error} />}
      {runs.data?.length === 0 && <Empty>no runs {activeOnly ? 'active' : 'yet'}</Empty>}

      {runs.data && runs.data.length > 0 && (
        <div className="p-8 pt-4">
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>run</TableHead>
                  <TableHead>status</TableHead>
                  <TableHead>pipeline</TableHead>
                  <TableHead>issue</TableHead>
                  <TableHead>step</TableHead>
                  <TableHead>latest</TableHead>
                  <TableHead>started</TableHead>
                  <TableHead>took</TableHead>
                  <TableHead className="text-right">cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link className="font-mono text-primary hover:underline" to={`/runs/${run.id}`}>
                        {shortId(run.id)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>{run.pipeline}</TableCell>
                    <TableCell>
                      {run.issueNumber !== null ? (
                        <Link className="text-primary hover:underline" to={`/issues/${run.issueNumber}`}>
                          #{run.issueNumber}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{run.currentStep}</TableCell>
                    <TableCell className="max-w-72 truncate text-muted-foreground">
                      {run.pendingQuestion ? (
                        <span className="text-amber-700 dark:text-amber-400" title={run.pendingQuestion}>
                          ❓ {run.pendingQuestion}
                        </span>
                      ) : (
                        <span title={run.lastVerdictSummary ?? ''}>{run.lastVerdictSummary ?? '—'}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {timeAgo(run.startedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {duration(run.startedAt, run.endedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                      {cost(run.costUsd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {dialog && <DispatchDialog onClose={() => setDialog(false)} />}
    </div>
  );
}
