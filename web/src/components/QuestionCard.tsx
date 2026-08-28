import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { answerQuestion } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { QuestionRow } from '../lib/types';

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
      className={`rounded-md border p-3 ${open ? 'border-warn/40 bg-warn/5' : 'border-border bg-panel-2'}`}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-dim">
        {open ? <span className="text-warn">❓ waiting for you</span> : <span>✓ answered</span>}
        <span>· {timeAgo(question.created_at)}</span>
        {context}
      </div>
      <pre className="font-sans mb-2 whitespace-pre-wrap text-sm">{question.body}</pre>

      {open ? (
        <div className="grid gap-2">
          {question.kind === 'multiple-choice' && question.choices && (
            <div className="flex flex-wrap gap-2">
              {question.choices.map((choice) => (
                <button
                  key={choice}
                  onClick={() => setAnswer(choice)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    answer === choice
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border text-dim hover:border-accent'
                  }`}
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer.trim() && !submit.isPending) {
                  submit.mutate(answer.trim());
                }
              }}
              placeholder="your answer (free text — qualifiers welcome)"
              className="min-w-0 flex-1 rounded-md border border-border bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              disabled={!answer.trim() || submit.isPending}
              onClick={() => submit.mutate(answer.trim())}
              className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-40"
            >
              {submit.isPending ? 'sending…' : 'answer'}
            </button>
          </div>
          {submit.isError && <div className="text-xs text-err">{String(submit.error)}</div>}
        </div>
      ) : (
        <div className="rounded bg-panel px-2 py-1.5 text-sm text-dim">↳ {question.answer}</div>
      )}
    </div>
  );
}
