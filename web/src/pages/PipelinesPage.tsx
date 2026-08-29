import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { disablePipeline, listPipelines } from '../lib/api';
import { Empty, ErrorNote, PageHeader, Spinner, StatusBadge } from '../components/ui';

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
        <Button onClick={() => navigate('/pipelines/new')} size="sm">
          + new pipeline
        </Button>
      </PageHeader>

      {pipelines.isLoading && (
        <div className="p-8">
          <Spinner />
        </div>
      )}
      {pipelines.isError && <ErrorNote error={pipelines.error} />}
      {pipelines.data?.length === 0 && <Empty>no pipelines defined</Empty>}

      <div className="mx-auto grid max-w-4xl gap-4 p-8 pt-6">
        {pipelines.data?.map((p) => (
          <Card key={p.id}>
            <CardContent>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      className="font-mono text-sm font-semibold text-primary hover:underline"
                      to={`/pipelines/${p.id}`}
                    >
                      {p.name}
                    </Link>
                    <StatusBadge status={p.enabled ? 'enabled' : 'disabled'} />
                    {p.inputSchema.issueNumber && (
                      <span className="text-muted-foreground/70 text-xs">
                        issue: {p.inputSchema.issueNumber}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-muted-foreground text-sm">{p.description}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                    {p.steps.map((s, i) => (
                      <span className="flex items-center gap-1.5" key={s.index}>
                        {i > 0 && <span className="text-muted-foreground/50">→</span>}
                        <span className="rounded-md bg-muted px-2 py-0.5 font-mono">
                          {s.name}
                          {s.allowedTools.includes('ask_human') && ' ❓'}
                          {s.retryWithFeedback > 0 && ` ↻${s.retryWithFeedback}`}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                {p.enabled && (
                  <Button
                    className="shrink-0"
                    onClick={() => {
                      if (window.confirm(`Disable pipeline "${p.name}"? Dispatches will be refused.`))
                        disable.mutate(p.id);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    disable
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
