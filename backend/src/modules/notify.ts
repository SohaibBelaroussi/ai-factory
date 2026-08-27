import { query } from '../db/client.js';

/**
 * Notify adapter — in-app only in v1: writes Notification rows. External
 * channels (Telegram/Slack/email) are later versions: new code inside this
 * module only, nothing else changes.
 */
export async function notify(args: {
  event: 'run-completed' | 'run-failed' | 'waiting-human' | 'factory-health';
  pipelineRunId?: string;
  questionId?: string;
  summary: string;
}): Promise<void> {
  await query(
    `insert into notifications (event, pipeline_run_id, question_id, summary)
     values ($1, $2, $3, $4)`,
    [args.event, args.pipelineRunId ?? null, args.questionId ?? null, args.summary],
  );
}
