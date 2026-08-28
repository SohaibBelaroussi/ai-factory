/**
 * API types — mirror the backend's actual response shapes exactly.
 * Some routes return camelCase projections, others raw snake_case rows;
 * these types are faithful to the wire, not idealized.
 */

// ---------- health / settings ----------

export type Check = { ok: boolean; detail: string };
export type Health = { ready: boolean; checks: Record<string, Check> };

export type SettingRow = {
  key: string;
  set: boolean;
  preview: string | null;
  updatedAt: string | null;
};

// ---------- pipelines ----------

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

export type PipelineInput = {
  name?: string;
  description?: string;
  inputSchema?: PipelineDefinition['inputSchema'];
  steps?: unknown;
};

// ---------- runs ----------

export type RunStatus = 'running' | 'waiting-human' | 'failed' | 'completed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting-human' | 'validating' | 'done' | 'failed';

export type Verdict = {
  status: 'done' | 'failed' | 'reject';
  summary: string;
  detailsArtifact?: string;
};

export type RunListItem = {
  id: string;
  pipeline: string;
  issueNumber: number | null;
  branch: string;
  status: RunStatus;
  currentStep: string; // "2/2: review"
  startedAt: string;
  endedAt: string | null;
  costUsd: string | null;
  lastVerdictSummary: string | null;
  pendingQuestion: string | null;
};

export type RunStep = {
  id: string;
  index: number;
  name: string;
  attempt: number;
  status: StepStatus;
  verdict: Verdict | null;
  commitShas: string[];
  costUsd: string | null;
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/** Question rows come back snake_case (raw DB rows). */
export type QuestionRow = {
  id: string;
  step_run_id: string;
  kind: 'text' | 'multiple-choice';
  body: string;
  choices: string[] | null;
  answer: string | null;
  status: 'open' | 'answered';
  created_at: string;
  answered_at: string | null;
};

/** /questions adds run context via join. */
export type QuestionListRow = QuestionRow & {
  pipeline_run_id: string;
  pipeline_name: string;
  issue_number: number | null;
};

export type RunDetail = {
  id: string;
  pipeline: string;
  issueNumber: number | null;
  branch: string;
  brief: string;
  status: RunStatus;
  currentStepIndex: number;
  createdBy: string;
  createdAt: string;
  endedAt: string | null;
  costUsd: string | null;
  definition: PipelineDefinition;
  steps: RunStep[];
  questions: QuestionRow[];
};

/** step_logs.id is a Postgres bigint — arrives as a string. */
export type LogRow = {
  id: string | number;
  step_run_id?: string;
  step_index: number;
  attempt: number;
  event: unknown;
  ts: string;
};

// ---------- board / issues ----------

export type BoardRow = {
  number: number;
  title: string;
  boardStatus: 'backlog' | 'in-progress' | 'needs-review' | 'completed' | 'blocked' | string;
  blockedBy: number[];
  activeRunId: string | null;
  linkedPr: string | null;
};

export type IssueDetail = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  boardStatus: string;
  dependencies: { blockedBy: number[]; satisfied: number[]; missing: number[]; blocked: boolean };
  linkedBranch: string | null;
  linkedPr: string | null;
  comments: { author: string; body: string }[];
  pastRuns: {
    id: string;
    pipeline: string;
    status: RunStatus;
    outcome: string | null;
    createdAt: string;
    endedAt: string | null;
  }[];
};

// ---------- notifications / chats ----------

export type NotificationRow = {
  id: string;
  event: string;
  pipeline_run_id: string | null;
  question_id: string | null;
  summary: string;
  read: boolean;
  created_at: string;
};

export type ChatRow = {
  id: string;
  title: string | null;
  sdk_session_id: string | null;
  created_at: string;
  last_message_at: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | string;
  content: string;
  ts: string;
};

/** Events on the Master chat turn stream (POST /chats/:id/messages). */
export type ChatTurnEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool.use'; name: string; input: unknown }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; message: string };

// ---------- errors ----------

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };
