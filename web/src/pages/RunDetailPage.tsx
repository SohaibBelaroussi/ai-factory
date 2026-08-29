import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { FileTextIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cancelRun, getArtifact, getRun } from '../lib/api';
import { cost, duration, shortId, timeAgo } from '../lib/format';
import type { RunStep } from '../lib/types';
import { LogViewer } from '../components/LogViewer';
import { QuestionCard } from '../components/QuestionCard';
import { ErrorNote, PageHeader, Spinner, StatusBadge } from '../components/ui';

function ArtifactDialog({
  runId,
  name,
  onClose,
}: {
  runId: string;
  name: string;
  onClose: () => void;
}): React.ReactNode {
  const artifact = useQuery({
    queryKey: ['artifact', runId, name],
    queryFn: () => getArtifact(runId, name),
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="flex h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">pipeline/{name}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-4">
          {artifact.isLoading && <Spinner />}
          {artifact.isError && <ErrorNote error={artifact.error} />}
          {artifact.data !== undefined && (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {artifact.data}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepRow({
  step,
  outputArtifact,
  onArtifact,
}: {
  step: RunStep;
  outputArtifact: string | null;
  onArtifact: (name: string) => void;
}): React.ReactNode {
  const artifacts = [
    ...(outputArtifact ? [outputArtifact] : []),
    ...(step.verdict?.detailsArtifact && step.verdict.detailsArtifact !== outputArtifact
      ? [step.verdict.detailsArtifact]
      : []),
  ];
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {step.index + 1}. {step.name}
        </span>
        {step.attempt > 1 && (
          <span className="text-amber-700 text-xs dark:text-amber-400">attempt {step.attempt}</span>
        )}
        <StatusBadge status={step.status} />
        {step.verdict && step.verdict.status !== 'done' && <StatusBadge status={step.verdict.status} />}
        <span className="ml-auto flex items-center gap-3 text-muted-foreground text-xs">
          <span>{duration(step.startedAt, step.endedAt)}</span>
          <span>{cost(step.costUsd)}</span>
        </span>
      </div>
      {step.verdict && <p className="mt-1.5 text-muted-foreground text-sm">{step.verdict.summary}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {artifacts.map((name) => (
          <Button
            className="h-6 gap-1 px-2 font-mono text-xs"
            key={name}
            onClick={() => onArtifact(name)}
            size="sm"
            variant="secondary"
          >
            <FileTextIcon className="size-3" /> {name}
          </Button>
        ))}
        {step.commitShas.map((sha) => (
          <span
            className="rounded-md bg-muted px-2 py-0.5 font-mono text-muted-foreground"
            key={sha}
            title={sha}
          >
            {sha.slice(0, 7)}
          </span>
        ))}
        {step.sessionId && (
          <span className="font-mono text-muted-foreground/60" title={`session ${step.sessionId}`}>
            ⌁ {shortId(step.sessionId)}
          </span>
        )}
      </div>
    </li>
  );
}

export default function RunDetailPage(): React.ReactNode {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ['run', id],
    queryFn: () => getRun(id!),
    enabled: !!id,
  });
  const cancel = useMutation({
    mutationFn: () => cancelRun(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['run', id] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const [artifact, setArtifact] = useState<string | null>(null);

  if (run.isLoading)
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  if (run.isError) return <ErrorNote error={run.error} />;
  if (!run.data) return null;
  const d = run.data;
  const cancellable = d.status === 'running' || d.status === 'waiting-human';
  const openQuestions = d.questions.filter((q) => q.status === 'open');
  const answeredQuestions = d.questions.filter((q) => q.status !== 'open');

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono text-lg">{shortId(d.id)}</span>
            <StatusBadge status={d.status} />
          </span>
        }
      >
        {cancellable && (
          <Button
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm('Cancel this run? Live containers are killed.')) cancel.mutate();
            }}
            size="sm"
            variant="destructive"
          >
            {cancel.isPending ? 'cancelling…' : 'cancel run'}
          </Button>
        )}
      </PageHeader>

      <div className="grid gap-6 p-8 pt-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid content-start gap-6">
          <Card>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <span className="text-muted-foreground">pipeline</span>
                <span>{d.pipeline}</span>
                <span className="text-muted-foreground">issue</span>
                <span>
                  {d.issueNumber !== null ? (
                    <Link className="text-primary hover:underline" to={`/issues/${d.issueNumber}`}>
                      #{d.issueNumber}
                    </Link>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="text-muted-foreground">branch</span>
                <span className="font-mono text-xs">{d.branch}</span>
                <span className="text-muted-foreground">created</span>
                <span>
                  {timeAgo(d.createdAt)} by {d.createdBy}
                </span>
                <span className="text-muted-foreground">took</span>
                <span>{duration(d.createdAt, d.endedAt)}</span>
                <span className="text-muted-foreground">cost</span>
                <span>{cost(d.costUsd)}</span>
              </div>
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-1 text-muted-foreground text-xs">brief</div>
                <pre className="whitespace-pre-wrap font-sans text-sm">{d.brief}</pre>
              </div>
            </CardContent>
          </Card>

          {(openQuestions.length > 0 || answeredQuestions.length > 0) && (
            <div className="grid gap-3">
              {openQuestions.map((q) => (
                <QuestionCard key={q.id} question={q} />
              ))}
              {answeredQuestions.map((q) => (
                <QuestionCard key={q.id} question={q} />
              ))}
            </div>
          )}

          <Card className="gap-0 py-0">
            <CardHeader className="border-b border-border py-4">
              <CardTitle className="font-display text-base">Steps</CardTitle>
            </CardHeader>
            <ul className="divide-y divide-border">
              {d.steps.map((step) => (
                <StepRow
                  key={step.id}
                  onArtifact={setArtifact}
                  outputArtifact={d.definition.steps[step.index]?.outputArtifact ?? null}
                  step={step}
                />
              ))}
            </ul>
          </Card>
        </div>

        <Card className="min-w-0 gap-0 py-0">
          <CardHeader className="border-b border-border py-4">
            <CardTitle className="font-display text-base">Session log</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <LogViewer runId={d.id} />
          </CardContent>
        </Card>
      </div>

      {artifact && <ArtifactDialog name={artifact} onClose={() => setArtifact(null)} runId={d.id} />}
    </div>
  );
}
