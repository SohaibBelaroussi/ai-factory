// Domain types (spec §4). DB rows are snake_case; these are the app-side shapes.

export type StepDefinition = {
  index: number;
  name: string;
  behaviorPrompt: string;
  model: string;
  allowedTools: string[];
  outputArtifact: string | null;
  askHumanCap: number;
  retryWithFeedback: number;
  timeoutMinutes: number;
};

export type PipelineDefinition = {
  id: string;
  name: string;
  description: string;
  inputSchema: { issueNumber?: 'required' | 'optional'; brief: 'required' };
  steps: StepDefinition[];
  enabled: boolean;
};

export type Verdict = {
  status: 'done' | 'failed' | 'reject';
  summary: string;
  detailsArtifact?: string;
};

export type RunStatus = 'running' | 'waiting-human' | 'failed' | 'completed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting-human' | 'validating' | 'done' | 'failed';

export type PipelineRunRow = {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  definition_snapshot: PipelineDefinition;
  issue_number: number | null;
  branch: string;
  brief: string;
  status: RunStatus;
  current_step_index: number;
  created_by: string;
  cost_usd: string | null;
  created_at: Date;
  ended_at: Date | null;
};

/**
 * What the runner passes between Inngest steps: a PipelineRunRow minus the
 * Date fields (step.run memoization serializes Dates to strings).
 */
export type RunCtx = Omit<PipelineRunRow, 'created_at' | 'ended_at'>;

export type StepRunRow = {
  id: string;
  pipeline_run_id: string;
  step_index: number;
  attempt: number;
  status: StepStatus;
  harness_session_id: string | null;
  verdict: Verdict | null;
  ask_human_count: number;
  commit_shas: string[];
  cost_usd: string | null;
  container_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
};

/** Machine-readable tail of every step (enforced via SDK outputFormat in the worker). */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed', 'reject'] },
    summary: {
      type: 'string',
      description: 'One line. Feeds the status board, run list, and notifications.',
    },
    detailsArtifact: {
      type: 'string',
      description: 'Optional pipeline/ artifact holding the full reasoning, e.g. "review.md".',
    },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
} as const;

export function parseVerdict(input: unknown): Verdict | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = input as Record<string, unknown>;
  if (v.status !== 'done' && v.status !== 'failed' && v.status !== 'reject') return null;
  if (typeof v.summary !== 'string' || v.summary.trim() === '') return null;
  const verdict: Verdict = { status: v.status, summary: v.summary.trim().split('\n')[0]!.slice(0, 500) };
  if (typeof v.detailsArtifact === 'string' && v.detailsArtifact.trim() !== '') {
    verdict.detailsArtifact = v.detailsArtifact.trim();
  }
  return verdict;
}

// Event catalog — the runner's entire vocabulary (architecture-expanded §4).
export const EVT = {
  runRequested: 'pipeline.run.requested',
  stepFinished: 'step.finished',
  stepWaitingHuman: 'step.waiting_human',
  questionAnswered: 'question.answered',
  runCompleted: 'pipeline.run.completed',
  runFailed: 'pipeline.run.failed',
  runCancelled: 'pipeline.run.cancelled',
} as const;

/**
 * Payload of step.finished, emitted by workers directly to Inngest — exactly
 * one per worker exit. The catalog's step.waiting_human signal rides in here
 * as outcome 'waiting_human' (one event name keeps the runner's waits strictly
 * linear and replay-deterministic; documented deviation from the two-name
 * catalog).
 */
export type StepFinishedData = {
  runId: string;
  stepRunId: string;
  outcome: 'done' | 'failed' | 'cancelled' | 'waiting_human';
  questionId?: string;
  verdict?: unknown;
  commitShas?: string[];
  sessionId?: string;
  error?: string;
  authFailure?: boolean;
};
