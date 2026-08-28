import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { cancelRun, getArtifact, getRun } from '../lib/api';
import { cost, duration, shortId, timeAgo } from '../lib/format';
import type { RunStep } from '../lib/types';
import { LogViewer } from '../components/LogViewer';
import { QuestionCard } from '../components/QuestionCard';
import { ErrorNote, PageHeader, Panel, Spinner, StatusBadge } from '../components/ui';

function ArtifactModal({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[760px] max-w-[94vw] flex-col rounded-lg border border-border bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="font-mono text-sm">pipeline/{name}</span>
          <button onClick={onClose} className="text-dim hover:text-ink">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {artifact.isLoading && <Spinner />}
          {artifact.isError && <ErrorNote error={artifact.error} />}
          {artifact.data !== undefined && (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{artifact.data}</pre>
          )}
        </div>
      </div>
    </div>
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
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {step.index + 1}. {step.name}
        </span>
        {step.attempt > 1 && <span className="text-xs text-warn">attempt {step.attempt}</span>}
        <StatusBadge status={step.status} />
        {step.verdict && step.verdict.status !== 'done' && (
          <StatusBadge status={step.verdict.status} />
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-dim">
          <span>{duration(step.startedAt, step.endedAt)}</span>
          <span>{cost(step.costUsd)}</span>
        </span>
      </div>
      {step.verdict && (
        <p className="mt-1.5 text-sm text-dim">{step.verdict.summary}</p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {artifacts.map((name) => (
          <button
            key={name}
            onClick={() => onArtifact(name)}
            className="rounded bg-panel-2 px-2 py-0.5 font-mono text-accent hover:bg-accent/15"
          >
            📄 {name}
          </button>
        ))}
        {step.commitShas.map((sha) => (
          <span key={sha} className="rounded bg-panel-2 px-2 py-0.5 font-mono text-faint" title={sha}>
            {sha.slice(0, 7)}
          </span>
        ))}
        {step.sessionId && (
          <span className="font-mono text-faint" title={`session ${step.sessionId}`}>
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
      <div className="p-6">
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
          <span className="flex items-center gap-2">
            <span className="font-mono">{shortId(d.id)}</span>
            <StatusBadge status={d.status} />
          </span>
        }
      >
        {cancellable && (
          <button
            onClick={() => {
              if (window.confirm('Cancel this run? Live containers are killed.')) cancel.mutate();
            }}
            disabled={cancel.isPending}
            className="rounded-md border border-err/40 px-3 py-1.5 text-sm text-err hover:bg-err/10 disabled:opacity-40"
          >
            {cancel.isPending ? 'cancelling…' : 'cancel run'}
          </button>
        )}
      </PageHeader>

      <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid content-start gap-6">
          <Panel className="p-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <span className="text-dim">pipeline</span>
              <span>{d.pipeline}</span>
              <span className="text-dim">issue</span>
              <span>
                {d.issueNumber !== null ? (
                  <Link to={`/issues/${d.issueNumber}`} className="text-accent hover:underline">
                    #{d.issueNumber}
                  </Link>
                ) : (
                  '—'
                )}
              </span>
              <span className="text-dim">branch</span>
              <span className="font-mono text-xs">{d.branch}</span>
              <span className="text-dim">created</span>
              <span>
                {timeAgo(d.createdAt)} by {d.createdBy}
              </span>
              <span className="text-dim">took</span>
              <span>{duration(d.createdAt, d.endedAt)}</span>
              <span className="text-dim">cost</span>
              <span>{cost(d.costUsd)}</span>
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-1 text-xs text-dim">brief</div>
              <pre className="font-sans whitespace-pre-wrap text-sm">{d.brief}</pre>
            </div>
          </Panel>

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

          <Panel>
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">Steps</div>
            <ul className="divide-y divide-border/50">
              {d.steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  outputArtifact={d.definition.steps[step.index]?.outputArtifact ?? null}
                  onArtifact={setArtifact}
                />
              ))}
            </ul>
          </Panel>
        </div>

        <Panel className="min-w-0 p-4">
          <div className="mb-2 text-sm font-semibold">Session log</div>
          <LogViewer runId={d.id} />
        </Panel>
      </div>

      {artifact && <ArtifactModal runId={d.id} name={artifact} onClose={() => setArtifact(null)} />}
    </div>
  );
}
