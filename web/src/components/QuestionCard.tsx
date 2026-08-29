import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { answerQuestion } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { QuestionRow } from '../lib/types';
import { cn } from '@/lib/utils';

/**
 * One pending/answered question. The answer box is the UI face of
 * POST /questions/:id/answer — same door the Master's tool uses.
 */
export function QuestionCard({
  question,
  context,
}: {
  question: QuestionRow;
  context?: React.ReactNode;
}): React.ReactNode {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState('');
  const submit = useMutation({
    mutationFn: (text: string) => answerQuestion(question.id, text),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['questions'] });
      void queryClient.invalidateQueries({ queryKey: ['run'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const open = question.status === 'open';

  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        open ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card',
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        {open ? (
          <Badge className="border-amber-500/40 text-amber-700 dark:text-amber-300" variant="outline">
            ❓ waiting for you
          </Badge>
        ) : (
          <Badge variant="secondary">answered</Badge>
        )}
        <span>{timeAgo(question.created_at)}</span>
        {context}
      </div>
      <pre className="mb-3 whitespace-pre-wrap font-sans text-sm">{question.body}</pre>

      {open ? (
        <div className="grid gap-2">
          {question.kind === 'multiple-choice' && question.choices && (
            <div className="flex flex-wrap gap-2">
              {question.choices.map((choice) => (
                <Button
                  key={choice}
                  onClick={() => setAnswer(choice)}
                  size="sm"
                  variant={answer === choice ? 'default' : 'outline'}
                >
                  {choice}
                </Button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer.trim() && !submit.isPending) {
                  submit.mutate(answer.trim());
                }
              }}
              placeholder="your answer (free text — qualifiers welcome)"
              value={answer}
            />
            <Button
              disabled={!answer.trim() || submit.isPending}
              onClick={() => submit.mutate(answer.trim())}
            >
              {submit.isPending ? 'sending…' : 'answer'}
            </Button>
          </div>
          {submit.isError && <p className="text-destructive text-xs">{String(submit.error)}</p>}
        </div>
      ) : (
        <div className="rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
          ↳ {question.answer}
        </div>
      )}
    </div>
  );
}
