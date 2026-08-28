import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { createPipeline, getPipeline, updatePipeline } from '../lib/api';
import type { StepDefinition } from '../lib/types';
import { ErrorNote, PageHeader, Panel, Spinner } from '../components/ui';

/**
 * The pipeline builder. Pipelines are data — this form edits the exact JSON
 * POST/PUT /pipelines validates. The tool vocabulary mirrors what workers
 * grant (SDK built-ins + ask_human).
 */

const TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'ask_human',
] as const;

const MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'];

type StepDraft = Omit<StepDefinition, 'index'>;

const NEW_STEP: StepDraft = {
  name: '',
  behaviorPrompt: '',
  model: 'claude-sonnet-5',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  outputArtifact: null,
  askHumanCap: 0,
  retryWithFeedback: 0,
  timeoutMinutes: 30,
};

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}): React.ReactNode {
  return (
    <label className="grid gap-1 text-xs text-dim">
      <span>
        {label} {hint && <span className="text-faint">— {hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  'rounded-md border border-border bg-panel-2 px-3 py-1.5 text-sm text-ink outline-none focus:border-accent';

function StepEditor({
  step,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  step: StepDraft;
  index: number;
  count: number;
  onChange: (next: StepDraft) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}): React.ReactNode {
  const askHuman = step.allowedTools.includes('ask_human');
  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold">step {index + 1}</span>
        <div className="ml-auto flex gap-1 text-xs">
          <button
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="rounded border border-border px-2 py-0.5 text-dim hover:text-ink disabled:opacity-30"
          >
            ↑
          </button>
          <button
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            className="rounded border border-border px-2 py-0.5 text-dim hover:text-ink disabled:opacity-30"
          >
            ↓
          </button>
          <button
            disabled={count === 1}
            onClick={onRemove}
            className="rounded border border-border px-2 py-0.5 text-dim hover:border-err/50 hover:text-err disabled:opacity-30"
          >
            remove
          </button>
        </div>
      </div>

      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="name">
            <input
              value={step.name}
              onChange={(e) => onChange({ ...step, name: e.target.value })}
              placeholder="e.g. plan-implement"
              className={inputCls}
            />
          </Field>
          <Field label="model">
            <input
              list="models"
              value={step.model}
              onChange={(e) => onChange({ ...step, model: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="behavior prompt" hint="the step's entire job description; judgment lives here">
          <textarea
            value={step.behaviorPrompt}
            onChange={(e) => onChange({ ...step, behaviorPrompt: e.target.value })}
            rows={8}
            className={`${inputCls} resize-y font-mono text-xs leading-relaxed`}
          />
        </Field>

        <Field label="allowed tools">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {TOOLS.map((tool) => (
              <label key={tool} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={step.allowedTools.includes(tool)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...step.allowedTools, tool]
                      : step.allowedTools.filter((t) => t !== tool);
                    onChange({
                      ...step,
                      allowedTools: next,
                      askHumanCap:
                        tool === 'ask_human' ? (e.target.checked ? step.askHumanCap || 3 : 0) : step.askHumanCap,
                    });
                  }}
                />
                {tool === 'ask_human' ? <span className="text-warn">{tool}</span> : tool}
              </label>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="output artifact" hint="under pipeline/">
            <input
              value={step.outputArtifact ?? ''}
              onChange={(e) => onChange({ ...step, outputArtifact: e.target.value || null })}
              placeholder="plan.md (optional)"
              className={inputCls}
            />
          </Field>
          <Field label="ask_human cap">
            <input
              type="number"
              min={0}
              max={10}
              disabled={!askHuman}
              value={step.askHumanCap}
              onChange={(e) => onChange({ ...step, askHumanCap: Number(e.target.value) })}
              className={`${inputCls} disabled:opacity-40`}
            />
          </Field>
          <Field label="retry w/ feedback" hint="on reject">
            <input
              type="number"
              min={0}
              max={5}
              value={step.retryWithFeedback}
              onChange={(e) => onChange({ ...step, retryWithFeedback: Number(e.target.value) })}
              className={inputCls}
            />
          </Field>
          <Field label="timeout (min)" hint="1–240">
            <input
              type="number"
              min={1}
              max={240}
              value={step.timeoutMinutes}
              onChange={(e) => onChange({ ...step, timeoutMinutes: Number(e.target.value) })}
              className={inputCls}
            />
          </Field>
        </div>
      </div>
    </Panel>
  );
}

export default function PipelineEditorPage(): React.ReactNode {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const existing = useQuery({
    queryKey: ['pipeline', id],
    queryFn: () => getPipeline(id!),
    enabled: !isNew,
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [issueMode, setIssueMode] = useState<'none' | 'optional' | 'required'>('optional');
  const [steps, setSteps] = useState<StepDraft[]>([{ ...NEW_STEP }]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (existing.data && !loaded) {
      setName(existing.data.name);
      setDescription(existing.data.description);
      setIssueMode(existing.data.inputSchema.issueNumber ?? 'none');
      setSteps(existing.data.steps.map(({ index: _index, ...rest }) => rest));
      setLoaded(true);
    }
  }, [existing.data, loaded]);

  const save = useMutation({
    mutationFn: () => {
      const inputSchema: { issueNumber?: 'required' | 'optional'; brief: 'required' } = {
        brief: 'required',
        ...(issueMode !== 'none' ? { issueNumber: issueMode } : {}),
      };
      const body = { description: description.trim(), inputSchema, steps };
      return isNew
        ? createPipeline({ name: name.trim(), ...body })
        : updatePipeline(id!, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['pipeline', id] });
      navigate('/pipelines');
    },
  });

  if (!isNew && existing.isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (!isNew && existing.isError) return <ErrorNote error={existing.error} />;

  const canSave =
    (isNew ? name.trim() !== '' : true) &&
    description.trim() !== '' &&
    steps.length > 0 &&
    steps.every((s) => s.name.trim() && s.behaviorPrompt.trim() && s.model.trim());

  return (
    <div>
      <PageHeader title={isNew ? 'New pipeline' : `Edit: ${existing.data?.name ?? ''}`}>
        <button
          onClick={() => navigate('/pipelines')}
          className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-ink"
        >
          cancel
        </button>
        <button
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
          className="rounded-md bg-accent-dim px-4 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-40"
        >
          {save.isPending ? 'saving…' : isNew ? 'create' : 'save'}
        </button>
      </PageHeader>

      <datalist id="models">
        {MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="grid max-w-4xl gap-4 p-6">
        {save.isError && <ErrorNote error={save.error} />}

        <Panel className="grid gap-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="name" hint={isNew ? 'immutable after creation' : 'immutable'}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isNew}
                placeholder="e.g. implement-qa"
                className={`${inputCls} disabled:opacity-50`}
              />
            </Field>
            <Field label="issue number">
              <select
                value={issueMode}
                onChange={(e) => setIssueMode(e.target.value as typeof issueMode)}
                className={inputCls}
              >
                <option value="none">not accepted</option>
                <option value="optional">optional</option>
                <option value="required">required</option>
              </select>
            </Field>
          </div>
          <Field
            label="description"
            hint="the Master discovers pipelines by this text — write it for an LLM choosing a tool"
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={`${inputCls} resize-y`}
            />
          </Field>
        </Panel>

        {steps.map((step, i) => (
          <StepEditor
            key={i}
            step={step}
            index={i}
            count={steps.length}
            onChange={(next) => setSteps(steps.map((s, j) => (j === i ? next : s)))}
            onMove={(dir) => {
              const next = [...steps];
              const [moved] = next.splice(i, 1);
              next.splice(i + dir, 0, moved!);
              setSteps(next);
            }}
            onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
          />
        ))}

        <button
          onClick={() => setSteps([...steps, { ...NEW_STEP }])}
          className="rounded-md border border-dashed border-border py-2 text-sm text-dim hover:border-accent hover:text-accent"
        >
          + add step
        </button>
      </div>
    </div>
  );
}
