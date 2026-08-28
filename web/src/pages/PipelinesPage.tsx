import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { disablePipeline, listPipelines } from '../lib/api';
import { Empty, ErrorNote, PageHeader, Panel, Spinner, StatusBadge } from '../components/ui';

export default function PipelinesPage(): React.ReactNode {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pipelines = useQuery({ queryKey: ['pipelines'], queryFn: listPipelines });
  const disable = useMutation({
    mutationFn: (id: string) => disablePipeline(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
  });

  return (
    <div>
      <PageHeader title="Pipelines">
        <button
          onClick={() => navigate('/pipelines/new')}
          className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          + new pipeline
        </button>
      </PageHeader>

      {pipelines.isLoading && (
        <div className="p-6">
          <Spinner />
        </div>
      )}
      {pipelines.isError && <ErrorNote error={pipelines.error} />}
      {pipelines.data?.length === 0 && <Empty>no pipelines defined</Empty>}

      <div className="grid max-w-4xl gap-4 p-6">
        {pipelines.data?.map((p) => (
          <Panel key={p.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/pipelines/${p.id}`}
                    className="font-mono text-sm font-semibold text-accent hover:underline"
                  >
                    {p.name}
                  </Link>
                  <StatusBadge status={p.enabled ? 'enabled' : 'disabled'} />
                  {p.inputSchema.issueNumber && (
                    <span className="text-xs text-faint">issue: {p.inputSchema.issueNumber}</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-dim">{p.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  {p.steps.map((s, i) => (
                    <span key={s.index} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-faint">→</span>}
                      <span className="rounded bg-panel-2 px-2 py-0.5 font-mono">
                        {s.name}
                        {s.allowedTools.includes('ask_human') && ' ❓'}
                        {s.retryWithFeedback > 0 && ` ↻${s.retryWithFeedback}`}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
              {p.enabled && (
                <button
                  onClick={() => {
                    if (window.confirm(`Disable pipeline "${p.name}"? Dispatches will be refused.`))
                      disable.mutate(p.id);
                  }}
                  className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-dim hover:border-err/50 hover:text-err"
                >
                  disable
                </button>
              )}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
