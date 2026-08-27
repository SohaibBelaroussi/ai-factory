import type { RunCtx, StepDefinition, Verdict } from '../domain/types.js';

/**
 * Layer 1 — harness prompt (spec §7). Written once by the operator, identical
 * for every step of every pipeline. Layers 1+2 are a stable prefix
 * (prompt-cache-friendly); layer 3 is assembled per step by the runner.
 */
export const HARNESS_PROMPT = `You are one step in a pipeline inside an AI factory.
Your input: the task brief and the artifacts under pipeline/ on the
current branch, plus the runtime context below. Read what you need with
your own tools — pointers are given, content is not pasted.
Your session is ephemeral: anything not committed to the branch or
written under pipeline/ is destroyed when you finish.
Finish by writing your declared output artifact (if any) and ending with
your verdict as structured output:
  status: done | failed | reject
  summary: <one line — this feeds the status board>
If you have the ask_human tool, use it only for decisions you cannot
make yourself, and prefer deciding. Stay within this step's job; do not
do the next step's work.`;

/** Layer 3 — runtime context. Assembled by the runner, never authored. By reference, small. */
export function buildRuntimeContext(args: {
  run: RunCtx;
  stepDef: StepDefinition;
  issueTitle: string | null;
  previous: { name: string; verdict: Verdict } | null;
  artifacts: string[];
  feedback: string | null;
  humanReplies?: string[];
}): string {
  const { run, stepDef, issueTitle, previous, artifacts, feedback, humanReplies } = args;
  const lines: string[] = [];
  lines.push(`brief: ${run.brief}`);
  lines.push(
    run.issue_number !== null
      ? `issue: #${run.issue_number}${issueTitle ? ` — ${issueTitle}` : ''} (read the full issue with your tools if needed)`
      : 'issue: none',
  );
  lines.push(`branch: ${run.branch}`);
  lines.push(
    stepDef.outputArtifact
      ? `expected output artifact: pipeline/${stepDef.outputArtifact}`
      : 'expected output artifact: none — your commits and verdict are the output',
  );
  if (previous) {
    lines.push(
      `previous step: ${previous.name} — verdict: ${previous.verdict.status} — "${previous.verdict.summary}"`,
    );
  }
  if (artifacts.length > 0) {
    lines.push(`artifacts available: ${artifacts.map((a) => `pipeline/${a}`).join(', ')}`);
  }
  if (feedback) {
    lines.push(`rejection feedback (address every point): ${feedback}`);
  }
  if (humanReplies && humanReplies.length > 0) {
    lines.push(`human replies so far: ${humanReplies.join(' | ')}`);
  }
  return lines.join('\n');
}
