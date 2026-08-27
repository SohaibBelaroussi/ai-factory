import { query } from '../db/client.js';
import type { PipelineDefinition, StepDefinition } from '../domain/types.js';

/** Pipelines are data. Adding a pipeline type = inserting rows, never deploying code. */

export function validateSteps(input: unknown): StepDefinition[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('steps must be a non-empty array');
  }
  return input.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== 'string' || !s.name.trim()) throw new Error(`step ${i}: name required`);
    if (typeof s.behaviorPrompt !== 'string' || !s.behaviorPrompt.trim()) {
      throw new Error(`step ${i}: behaviorPrompt required`);
    }
    if (typeof s.model !== 'string' || !s.model.trim()) throw new Error(`step ${i}: model required`);
    if (!Array.isArray(s.allowedTools) || !s.allowedTools.every((t) => typeof t === 'string')) {
      throw new Error(`step ${i}: allowedTools must be a string array`);
    }
    const outputArtifact =
      s.outputArtifact == null || s.outputArtifact === '' ? null : String(s.outputArtifact);
    if (outputArtifact && !/^[\w][\w.-]*$/.test(outputArtifact)) {
      throw new Error(`step ${i}: outputArtifact must be a bare filename (lives under pipeline/)`);
    }
    const askHuman = (s.allowedTools as string[]).includes('ask_human');
    const askHumanCap = Number(s.askHumanCap ?? (askHuman ? 3 : 0));
    if (!askHuman && askHumanCap > 0) {
      throw new Error(`step ${i}: askHumanCap > 0 but ask_human is not in allowedTools`);
    }
    const timeoutMinutes = Number(s.timeoutMinutes ?? 30);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) {
      throw new Error(`step ${i}: timeoutMinutes must be 1–240`);
    }
    return {
      index: i,
      name: s.name.trim(),
      behaviorPrompt: s.behaviorPrompt,
      model: s.model.trim(),
      allowedTools: s.allowedTools as string[],
      outputArtifact,
      askHumanCap,
      retryWithFeedback: Math.max(0, Number(s.retryWithFeedback ?? 0)),
      timeoutMinutes,
    };
  });
}

type PipelineRow = {
  id: string;
  name: string;
  description: string;
  input_schema: PipelineDefinition['inputSchema'];
  steps: StepDefinition[];
  enabled: boolean;
};

function toDefinition(row: PipelineRow): PipelineDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    inputSchema: row.input_schema,
    steps: row.steps,
    enabled: row.enabled,
  };
}

export async function listPipelines(): Promise<PipelineDefinition[]> {
  const res = await query<PipelineRow>('select * from pipeline_definitions order by name');
  return res.rows.map(toDefinition);
}

export async function getPipeline(idOrName: string): Promise<PipelineDefinition | null> {
  const res = await query<PipelineRow>(
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(idOrName)
      ? 'select * from pipeline_definitions where id = $1'
      : 'select * from pipeline_definitions where name = $1',
    [idOrName],
  );
  return res.rows[0] ? toDefinition(res.rows[0]) : null;
}

export async function createPipeline(args: {
  name: string;
  description: string;
  inputSchema: PipelineDefinition['inputSchema'];
  steps: unknown;
}): Promise<PipelineDefinition> {
  const steps = validateSteps(args.steps);
  const res = await query<PipelineRow>(
    `insert into pipeline_definitions (name, description, input_schema, steps)
     values ($1, $2, $3, $4) returning *`,
    [args.name, args.description, JSON.stringify(args.inputSchema), JSON.stringify(steps)],
  );
  return toDefinition(res.rows[0]!);
}

export async function updatePipeline(
  id: string,
  args: { description?: string; inputSchema?: PipelineDefinition['inputSchema']; steps?: unknown },
): Promise<PipelineDefinition | null> {
  const existing = await getPipeline(id);
  if (!existing) return null;
  const steps = args.steps !== undefined ? validateSteps(args.steps) : existing.steps;
  const res = await query<PipelineRow>(
    `update pipeline_definitions
     set description = $2, input_schema = $3, steps = $4, updated_at = now()
     where id = $1 returning *`,
    [
      existing.id,
      args.description ?? existing.description,
      JSON.stringify(args.inputSchema ?? existing.inputSchema),
      JSON.stringify(steps),
    ],
  );
  return toDefinition(res.rows[0]!);
}

export async function disablePipeline(id: string): Promise<boolean> {
  const res = await query(
    'update pipeline_definitions set enabled = false, updated_at = now() where id = $1',
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Seed fixture: the `implement` pipeline (spec §6.3). Idempotent by name.

const PLAN_IMPLEMENT_PROMPT = `You are the implementation step of a software factory pipeline.
Objective: take the task brief (and the GitHub issue it references, if any),
produce a short implementation plan, then implement it fully on the current
branch. Planning and implementing share your session on purpose — continuity
is the feature here.

Working method:
- Read the issue and the existing code first; keep the plan proportional to
  the task.
- Write your plan to pipeline/plan.md BEFORE implementing: goal, approach,
  files you expect to touch, test strategy, risks.
- Implement the plan completely. Real code only — no placeholders, no TODOs.
- Run the repository's tests; add or update tests where behavior changed.
  If tests fail and you cannot fix them, be honest: verdict status "failed".
- Commit your work in small, well-messaged commits as you go.
- If rejection feedback from a review is present in your runtime context,
  address every point and record in pipeline/plan.md how each was addressed.

Quality bar: the diff should be reviewable by a senior engineer without
surprises — consistent with the codebase's style, no unrelated changes,
tests passing.`;

const REVIEW_PROMPT = `You are the review step of a software factory pipeline — fresh eyes.
Objective: review the changes this pipeline made on the current branch
against the brief and pipeline/plan.md. You start with no memory of how the
code was written — that independence is the feature.

Working method:
- Read pipeline/brief.md and pipeline/plan.md, then review the actual diff
  (git log, git diff against the default branch) and any file you need.
- Judge: correctness, completeness against the brief, test coverage and
  whether the tests plausibly pass, style consistency, unintended changes.
- Do NOT fix or modify code. The only file you may write is
  pipeline/review.md — your full findings: verdict first, then findings
  ordered by severity, each with file/line pointers.

Verdict rules: status "done" if the work is mergeable as-is or with trivial
nits; status "reject" if anything must change before merge — put the
must-fix items in the one-line summary (it is fed back to the implementer)
and set detailsArtifact to "review.md".`;

export async function seedPipelines(): Promise<void> {
  const existing = await getPipeline('implement');
  if (existing) return;
  await createPipeline({
    name: 'implement',
    description:
      'Implement a GitHub issue or a well-scoped task brief end-to-end: plans, implements, and commits code on a dedicated branch, then an independent review step gates the result. Fully autonomous — use for concrete implementation work that needs no human approval mid-flight.',
    inputSchema: { issueNumber: 'optional', brief: 'required' },
    steps: [
      {
        name: 'plan-implement',
        behaviorPrompt: PLAN_IMPLEMENT_PROMPT,
        model: 'claude-sonnet-5',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'],
        outputArtifact: 'plan.md',
        askHumanCap: 0,
        retryWithFeedback: 2,
        timeoutMinutes: 45,
      },
      {
        name: 'review',
        behaviorPrompt: REVIEW_PROMPT,
        model: 'claude-sonnet-5',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
        outputArtifact: 'review.md',
        askHumanCap: 0,
        retryWithFeedback: 0,
        timeoutMinutes: 20,
      },
    ],
  });
  console.log('Seeded pipeline: implement');
}
