import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">Dispatch a run</DialogTitle>
          <DialogDescription>
            Every dispatch is a plain POST /runs — reproducible with curl.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Pipeline</Label>
            {pipelines.isLoading ? (
              <Spinner />
            ) : (
              <Select onValueChange={setPipeline} value={pipeline}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="choose a pipeline" />
                </SelectTrigger>
                <SelectContent>
                  {enabled.map((p) => (
                    <SelectItem key={p.id} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selected && (
              <p className="text-muted-foreground text-xs">{selected.description}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>Issue number {issueRequired ? '(required)' : '(optional)'}</Label>
            <Input
              inputMode="numeric"
              onChange={(e) => setIssue(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 12"
              value={issue}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Brief</Label>
            <Textarea
              onChange={(e) => setBrief(e.target.value)}
              placeholder="What should this run accomplish?"
              rows={4}
              value={brief}
            />
          </div>

          <label className="flex items-center gap-2 text-muted-foreground text-sm">
            <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
            force — override closed-issue and dependency checks
          </label>

          {refusal && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <div className="mb-1 font-semibold">refused: {String(refusal.reason ?? 'unknown')}</div>
              <pre className="overflow-x-auto text-muted-foreground">
                {JSON.stringify(refusal, null, 2)}
              </pre>
            </div>
          )}
          {dispatch.isError && !(dispatch.error instanceof Refusal) && (
            <p className="text-destructive text-xs">{String(dispatch.error)}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              setRefusal(null);
              dispatch.mutate();
            }}
          >
            {dispatch.isPending ? 'dispatching…' : 'dispatch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
