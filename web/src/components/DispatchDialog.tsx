import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listPipelines, spawnRun, Refusal } from '../lib/api';
import { Spinner } from './ui';

/**
 * Dispatch a pipeline run — the UI face of POST /runs. Refusals (409) are
 * rendered as data, exactly as the API returns them.
 */
export function DispatchDialog({
  issueNumber,
  onClose,
}: {
  issueNumber?: number;
  onClose: () => void;
}): React.ReactNode {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pipelines = useQuery({ queryKey: ['pipelines'], queryFn: listPipelines });
  const enabled = pipelines.data?.filter((p) => p.enabled) ?? [];

  const [pipeline, setPipeline] = useState('');
  const [issue, setIssue] = useState(issueNumber?.toString() ?? '');
  const [brief, setBrief] = useState('');
  const [force, setForce] = useState(false);
  const [refusal, setRefusal] = useState<Record<string, unknown> | null>(null);

  const selected = enabled.find((p) => p.name === pipeline);
  const issueRequired = selected?.inputSchema.issueNumber === 'required';

  const dispatch = useMutation({
    mutationFn: () =>
      spawnRun({
        pipeline,
        issueNumber: issue.trim() ? Number(issue) : undefined,
        brief: brief.trim(),
        force: force || undefined,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      onClose();
      navigate(`/runs/${res.runId}`);
    },
    onError: (err) => {
      if (err instanceof Refusal) setRefusal(err.refusal);
    },
  });

  const canSubmit =
    !!selected && brief.trim() !== '' && (!issueRequired || issue.trim() !== '') && !dispatch.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-lg border border-border bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">
          Dispatch a run
        </div>
        <div className="grid gap-3 p-4">
          <label className="grid gap-1 text-xs text-dim">
            pipeline
            {pipelines.isLoading ? (
              <Spinner />
            ) : (
              <select
                value={pipeline}
                onChange={(e) => setPipeline(e.target.value)}
                className="rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">— choose —</option>
                {enabled.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {selected && <span className="text-faint">{selected.description}</span>}
          </label>

          <label className="grid gap-1 text-xs text-dim">
            issue number {issueRequired ? '(required)' : '(optional)'}
            <input
              value={issue}
              onChange={(e) => setIssue(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 12"
              className="rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </label>

          <label className="grid gap-1 text-xs text-dim">
            brief
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              placeholder="What should this run accomplish?"
              className="resize-y rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-dim">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            force (override closed-issue and dependency checks)
          </label>

          {refusal && (
            <div className="rounded-md border border-warn/30 bg-warn/10 p-3 text-xs">
              <div className="mb-1 font-semibold text-warn">
                refused: {String(refusal.reason ?? 'unknown')}
              </div>
              <pre className="overflow-x-auto text-dim">{JSON.stringify(refusal, null, 2)}</pre>
            </div>
          )}
          {dispatch.isError && !(dispatch.error instanceof Refusal) && (
            <div className="rounded-md border border-err/30 bg-err/10 p-3 text-xs text-err">
              {String(dispatch.error)}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-ink">
            cancel
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => {
              setRefusal(null);
              dispatch.mutate();
            }}
            className="rounded-md bg-accent-dim px-4 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-40"
          >
            {dispatch.isPending ? 'dispatching…' : 'dispatch'}
          </button>
        </div>
      </div>
    </div>
  );
}
