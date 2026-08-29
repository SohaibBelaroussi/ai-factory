import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createPipeline, getPipeline, updatePipeline } from '../lib/api';
import type { StepDefinition } from '../lib/types';
import { ErrorNote, PageHeader, Spinner } from '../components/ui';

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
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="font-display text-base">step {index + 1}</CardTitle>
        <div className="flex gap-1">
          <Button
            disabled={index === 0}
            onClick={() => onMove(-1)}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
          <Button
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowDownIcon className="size-4" />
          </Button>
          <Button disabled={count === 1} onClick={onRemove} size="icon-sm" variant="ghost">
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <Label>name</Label>
            <Input
              onChange={(e) => onChange({ ...step, name: e.target.value })}
              placeholder="e.g. plan-implement"
              value={step.name}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>model</Label>
            <Input
              list="models"
              onChange={(e) => onChange({ ...step, model: e.target.value })}
              value={step.model}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label>
            behavior prompt{' '}
            <span className="font-normal text-muted-foreground">
              — the step's entire job description; judgment lives here
            </span>
          </Label>
          <Textarea
            className="resize-y font-mono text-xs leading-relaxed"
            onChange={(e) => onChange({ ...step, behaviorPrompt: e.target.value })}
            rows={8}
            value={step.behaviorPrompt}
          />
        </div>

        <div className="grid gap-1.5">
          <Label>allowed tools</Label>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {TOOLS.map((tool) => (
              <label className="flex items-center gap-2 text-sm" key={tool}>
                <Checkbox
                  checked={step.allowedTools.includes(tool)}
                  onCheckedChange={(v) => {
                    const checked = v === true;
                    const next = checked
                      ? [...step.allowedTools, tool]
                      : step.allowedTools.filter((t) => t !== tool);
                    onChange({
                      ...step,
                      allowedTools: next,
                      askHumanCap:
                        tool === 'ask_human' ? (checked ? step.askHumanCap || 3 : 0) : step.askHumanCap,
                    });
                  }}
                />
                {tool === 'ask_human' ? (
                  <span className="text-amber-700 dark:text-amber-400">{tool}</span>
                ) : (
                  tool
                )}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>output artifact</Label>
            <Input
              onChange={(e) => onChange({ ...step, outputArtifact: e.target.value || null })}
              placeholder="plan.md (optional)"
              value={step.outputArtifact ?? ''}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>ask_human cap</Label>
            <Input
              disabled={!askHuman}
              max={10}
              min={0}
              onChange={(e) => onChange({ ...step, askHumanCap: Number(e.target.value) })}
              type="number"
              value={step.askHumanCap}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>retry w/ feedback</Label>
            <Input
              max={5}
              min={0}
              onChange={(e) => onChange({ ...step, retryWithFeedback: Number(e.target.value) })}
              type="number"
              value={step.retryWithFeedback}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>timeout (min)</Label>
            <Input
              max={240}
              min={1}
              onChange={(e) => onChange({ ...step, timeoutMinutes: Number(e.target.value) })}
              type="number"
              value={step.timeoutMinutes}
            />
          </div>
        </div>
      </CardContent>
    </Card>
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
      return isNew ? createPipeline({ name: name.trim(), ...body }) : updatePipeline(id!, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['pipeline', id] });
      navigate('/pipelines');
    },
  });

  if (!isNew && existing.isLoading)
    return (
      <div className="p-8">
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
        <Button onClick={() => navigate('/pipelines')} size="sm" variant="ghost">
          cancel
        </Button>
        <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()} size="sm">
          {save.isPending ? 'saving…' : isNew ? 'create' : 'save'}
        </Button>
      </PageHeader>

      <datalist id="models">
        {MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="mx-auto grid max-w-4xl gap-4 p-8 pt-6">
        {save.isError && <ErrorNote error={save.error} />}

        <Card>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label>
                  name{' '}
                  <span className="font-normal text-muted-foreground">— immutable after creation</span>
                </Label>
                <Input
                  disabled={!isNew}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. implement-qa"
                  value={name}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>issue number</Label>
                <Select onValueChange={(v) => setIssueMode(v as typeof issueMode)} value={issueMode}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">not accepted</SelectItem>
                    <SelectItem value="optional">optional</SelectItem>
                    <SelectItem value="required">required</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>
                description{' '}
                <span className="font-normal text-muted-foreground">
                  — the Master discovers pipelines by this text; write it for an LLM choosing a tool
                </span>
              </Label>
              <Textarea
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                value={description}
              />
            </div>
          </CardContent>
        </Card>

        {steps.map((step, i) => (
          <StepEditor
            count={steps.length}
            index={i}
            key={i}
            onChange={(next) => setSteps(steps.map((s, j) => (j === i ? next : s)))}
            onMove={(dir) => {
              const next = [...steps];
              const [moved] = next.splice(i, 1);
              next.splice(i + dir, 0, moved!);
              setSteps(next);
            }}
            onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
            step={step}
          />
        ))}

        <Button
          className="border-dashed"
          onClick={() => setSteps([...steps, { ...NEW_STEP }])}
          variant="outline"
        >
          + add step
        </Button>
      </div>
    </div>
  );
}
