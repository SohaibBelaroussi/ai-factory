import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db/client.js';
import { config } from '../config.js';
import type {
  PipelineRunRow,
  RunCtx,
  StepDefinition,
  StepFinishedData,
  Verdict,
} from '../domain/types.js';
import { parseVerdict } from '../domain/types.js';
import { HARNESS_PROMPT, buildRuntimeContext } from './prompts.js';
import * as github from './github.js';
import * as provisioner from './provisioner.js';
import { getSetting } from './settings.js';
import { notify } from './notify.js';
import { archiveRunArtifacts } from './artifacts.js';
import { deleteStepSession } from './sessionStore.js';

/**
 * Everything the runner does to the world, as plain async functions called
 * inside Inngest step.run closures. All return values are JSON-serializable
 * (they get memoized in Inngest's durable log).
 */

export async function loadRun(runId: string): Promise<PipelineRunRow | null> {
  const res = await query<PipelineRunRow>('select * from pipeline_runs where id = $1', [runId]);
  return res.rows[0] ?? null;
}

/**
 * Create the run branch (or reuse it) and write pipeline/brief.md. Stale
 * pipeline/ artifacts inherited from earlier runs (merged PRs carry them into
 * the default branch) are cleared first — a run's artifact set is its own,
 * and an inherited file must never satisfy this run's output contract.
 */
export async function prepareRun(run: RunCtx): Promise<void> {
  await github.ensureBranch(run.branch);
  try {
    const stale = await github.listPipelineArtifacts(run.branch);
    for (const name of stale) {
      await github.deleteFile(run.branch, `pipeline/${name}`, `pipeline: clear stale artifact for run ${run.id}`);
    }
  } catch {
    // best-effort; a missing pipeline/ dir is the common case
  }
  await github.putFile(
    run.branch,
    'pipeline/brief.md',
    `# Brief\n\n${run.brief}\n\n(issue: ${run.issue_number ?? 'none'} · pipeline: ${run.pipeline_name} · run: ${run.id})\n`,
    `pipeline: write brief for run ${run.id}`,
  );
}

export type Provisioned = { stepRunId: string; containerId: string };

export async function provisionStep(
  run: RunCtx,
  stepDef: StepDefinition,
  attempt: number,
  feedback: string | null,
): Promise<Provisioned> {
  // Step-run row, idempotent on (run, index, attempt) for Inngest step retries.
  const stepRes = await query<{ id: string }>(
    `insert into step_runs (pipeline_run_id, step_index, attempt, status, started_at)
     values ($1, $2, $3, 'running', now())
     on conflict (pipeline_run_id, step_index, attempt)
     do update set status = 'running', started_at = now(), ended_at = null
     returning id`,
    [run.id, stepDef.index, attempt],
  );
  const stepRunId = stepRes.rows[0]!.id;

  // Internal-plane scoped token: worker can only touch its own step's rows.
  const token = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await query(
    `update step_runs set internal_token_hash = $2,
       internal_token_expires_at = now() + ($3 || ' minutes')::interval
     where id = $1`,
    [stepRunId, tokenHash, String(stepDef.timeoutMinutes + 15)],
  );

  // Layer-3 inputs: previous verdict, available artifacts, issue title.
  const prevRes = await query<{ verdict: Verdict; step_index: number }>(
    `select verdict, step_index from step_runs
     where pipeline_run_id = $1 and status = 'done' and verdict is not null
     order by ended_at desc limit 1`,
    [run.id],
  );
  const prev = prevRes.rows[0]
    ? {
        name: run.definition_snapshot.steps[prevRes.rows[0].step_index]?.name ?? 'previous',
        verdict: prevRes.rows[0].verdict,
      }
    : null;

  let artifacts: string[] = [];
  try {
    artifacts = await github.listPipelineArtifacts(run.branch);
  } catch {
    // branch listing is advisory; the step can discover files itself
  }
  let issueTitle: string | null = null;
  if (run.issue_number !== null) {
    const cached = await query<{ title: string }>('select title from issue_cache where number = $1', [
      run.issue_number,
    ]);
    issueTitle = cached.rows[0]?.title ?? null;
  }

  const runtimeContext = buildRuntimeContext({
    run,
    stepDef,
    issueTitle,
    previous: prev,
    artifacts,
    feedback,
  });

  const [claudeToken, gitToken, repo] = await Promise.all([
    getSetting('claude-oauth-token'),
    getSetting('github-token'),
    github.getRepoFullName(),
  ]);
  if (!claudeToken || !gitToken) throw new Error('claude-oauth-token / github-token not set');

  const stepContext = {
    stepRunId,
    runId: run.id,
    branch: run.branch,
    repo,
    stepName: stepDef.name,
    stepIndex: stepDef.index,
    attempt,
    harnessPrompt: HARNESS_PROMPT,
    behaviorPrompt: stepDef.behaviorPrompt,
    runtimeContext,
    allowedTools: stepDef.allowedTools,
    model: stepDef.model,
    outputArtifact: stepDef.outputArtifact,
    timeoutMinutes: stepDef.timeoutMinutes,
    askHumanCap: stepDef.askHumanCap,
  };

  const containerId = await provisioner.startWorker({
    name: `factory-step-${stepRunId}`,
    env: {
      WORKER_MODE: 'step',
      STEP_CONTEXT: JSON.stringify(stepContext),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
      GIT_TOKEN: gitToken,
      INTERNAL_API_URL: config.internalApiUrl,
      INTERNAL_TOKEN: token,
      INNGEST_EVENT_URL: `${config.inngestBaseUrl}/e/${config.inngestEventKey}`,
    },
  });

  await query('update step_runs set container_id = $2, log_ref = $1 where id = $1', [
    stepRunId,
    containerId,
  ]);
  await query('update pipeline_runs set current_step_index = $2 where id = $1', [
    run.id,
    stepDef.index,
  ]);
  return { stepRunId, containerId };
}

/** After the worker suspends itself on ask_human: only the corpse needs removing. */
export async function suspendStepCleanup(prov: Provisioned): Promise<void> {
  await query('update step_runs set internal_token_hash = null where id = $1', [prov.stepRunId]);
  await provisioner.removeWorker(prov.containerId);
}

/**
 * Resume a suspended step: fresh worker, new scoped token, same step_run row,
 * same session id — the answer arrives as the next user message.
 */
export async function resumeStep(
  run: RunCtx,
  stepDef: StepDefinition,
  stepRunId: string,
  answer: string,
  resumeCount: number,
): Promise<Provisioned> {
  const row = await query<{ harness_session_id: string | null; attempt: number }>(
    'select harness_session_id, attempt from step_runs where id = $1',
    [stepRunId],
  );
  const sessionId = row.rows[0]?.harness_session_id;
  if (!sessionId) throw new Error(`step ${stepRunId} has no session id to resume`);

  const token = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await query(
    `update step_runs set status = 'running', internal_token_hash = $2,
       internal_token_expires_at = now() + ($3 || ' minutes')::interval
     where id = $1`,
    [stepRunId, tokenHash, String(stepDef.timeoutMinutes + 15)],
  );
  await query(`update pipeline_runs set status = 'running' where id = $1 and status = 'waiting-human'`, [
    run.id,
  ]);

  const [claudeToken, gitToken, repo] = await Promise.all([
    getSetting('claude-oauth-token'),
    getSetting('github-token'),
    github.getRepoFullName(),
  ]);
  if (!claudeToken || !gitToken) throw new Error('claude-oauth-token / github-token not set');

  const stepContext = {
    stepRunId,
    runId: run.id,
    branch: run.branch,
    repo,
    stepName: stepDef.name,
    stepIndex: stepDef.index,
    attempt: row.rows[0]!.attempt,
    harnessPrompt: HARNESS_PROMPT,
    behaviorPrompt: stepDef.behaviorPrompt,
    runtimeContext: '',
    allowedTools: stepDef.allowedTools,
    model: stepDef.model,
    outputArtifact: stepDef.outputArtifact,
    timeoutMinutes: stepDef.timeoutMinutes,
    askHumanCap: stepDef.askHumanCap,
    resumeSessionId: sessionId,
    resumePrompt: `The human answered your question: "${answer}"\nContinue the step from where you paused. Finish by writing your declared output artifact (if any) and your verdict.`,
  };

  const containerId = await provisioner.startWorker({
    name: `factory-step-${stepRunId}-r${resumeCount}`,
    env: {
      WORKER_MODE: 'step',
      STEP_CONTEXT: JSON.stringify(stepContext),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
      GIT_TOKEN: gitToken,
      INTERNAL_API_URL: config.internalApiUrl,
      INTERNAL_TOKEN: token,
      INNGEST_EVENT_URL: `${config.inngestBaseUrl}/e/${config.inngestEventKey}`,
    },
  });
  await query('update step_runs set container_id = $2 where id = $1', [stepRunId, containerId]);
  return { stepRunId, containerId };
}

export type StepOutcome =
  | { kind: 'done' }
  | { kind: 'reject'; feedback: string }
  | { kind: 'failed'; reason: string; authFailure?: boolean }
  | { kind: 'cancelled' };

/**
 * Contract validation + persistence after the wait resolves (or times out).
 * evt is the step.finished payload, or null on waitForEvent timeout.
 */
export async function finalizeStep(
  run: RunCtx,
  stepDef: StepDefinition,
  prov: Provisioned,
  evt: StepFinishedData | null,
  attempt: number,
): Promise<StepOutcome> {
  const fail = async (reason: string, authFailure?: boolean): Promise<StepOutcome> => {
    await query(
      `update step_runs set status = 'failed', ended_at = now(), internal_token_hash = null
       where id = $1`,
      [prov.stepRunId],
    );
    await provisioner.removeWorker(prov.containerId, prov.stepRunId);
    await deleteStepSession(prov.stepRunId);
    return { kind: 'failed', reason, authFailure };
  };

  if (evt === null) {
    await provisioner.killWorker(prov.containerId);
    return fail(`step "${stepDef.name}" timed out after ${stepDef.timeoutMinutes} minutes`);
  }
  if (evt.outcome === 'cancelled') {
    await provisioner.removeWorker(prov.containerId, prov.stepRunId);
    return { kind: 'cancelled' };
  }
  if (evt.outcome === 'failed') {
    if (evt.sessionId) {
      await query('update step_runs set harness_session_id = $2 where id = $1', [
        prov.stepRunId,
        evt.sessionId,
      ]);
    }
    return fail(evt.error ?? `step "${stepDef.name}" failed`, evt.authFailure);
  }

  // outcome === 'done': validate the output contract in code.
  await query(`update step_runs set status = 'validating' where id = $1`, [prov.stepRunId]);

  const verdict = parseVerdict(evt.verdict);
  if (!verdict) {
    return fail(`step "${stepDef.name}" produced no parseable verdict`);
  }

  if (stepDef.outputArtifact) {
    // Filesystem truth is checked in code; small retry for GitHub read-after-write.
    let exists = false;
    for (let i = 0; i < 3 && !exists; i++) {
      try {
        exists = await github.fileExists(run.branch, `pipeline/${stepDef.outputArtifact}`);
      } catch {
        exists = false;
      }
      if (!exists) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!exists) {
      return fail(
        `step "${stepDef.name}" declared artifact pipeline/${stepDef.outputArtifact} but it is not on ${run.branch}`,
      );
    }
  }

  await query(
    `update step_runs set status = 'done', verdict = $2, commit_shas = $3,
       harness_session_id = $4, ended_at = now(), internal_token_hash = null
     where id = $1`,
    [
      prov.stepRunId,
      JSON.stringify(verdict),
      JSON.stringify(evt.commitShas ?? []),
      evt.sessionId ?? null,
    ],
  );
  await provisioner.removeWorker(prov.containerId);
  await deleteStepSession(prov.stepRunId);

  if (verdict.status === 'failed') {
    return { kind: 'failed', reason: `step "${stepDef.name}" verdict: ${verdict.summary}` };
  }
  if (verdict.status === 'reject') {
    const pointer = verdict.detailsArtifact ? ` (details: pipeline/${verdict.detailsArtifact})` : '';
    return { kind: 'reject', feedback: `${verdict.summary}${pointer}` };
  }
  return { kind: 'done' };
}

async function sumRunCost(runId: string): Promise<void> {
  await query(
    `update pipeline_runs set cost_usd =
       (select coalesce(sum(cost_usd), 0) from step_runs where pipeline_run_id = $1)
     where id = $1`,
    [runId],
  );
}

export async function failRun(
  run: RunCtx,
  reason: string,
  authFailure?: boolean,
): Promise<void> {
  await query(
    `update pipeline_runs set status = 'failed', ended_at = now() where id = $1 and status in ('running','waiting-human')`,
    [run.id],
  );
  await sumRunCost(run.id);
  // Preserve the record; the branch keeps its files for human debugging.
  await archiveRunArtifacts(run.id, run.branch);
  if (run.issue_number !== null) {
    await query('update issue_cache set active_run_id = null where number = $1', [run.issue_number]);
  }
  await notify({
    event: 'run-failed',
    pipelineRunId: run.id,
    summary: `${run.pipeline_name}${run.issue_number !== null ? ` #${run.issue_number}` : ''} failed: ${reason}`.slice(0, 500),
  });
  if (authFailure) {
    await notify({
      event: 'factory-health',
      pipelineRunId: run.id,
      summary:
        'Worker auth failure: the Claude OAuth token was rejected. Rotate it via PUT /settings/claude-token.',
    });
  }
}

export async function completeRun(run: RunCtx): Promise<void> {
  await query(
    `update pipeline_runs set status = 'completed', ended_at = now() where id = $1 and status = 'running'`,
    [run.id],
  );
  await sumRunCost(run.id);
  const stepVerdicts = await query<{ step_index: number; attempt: number; verdict: Verdict }>(
    `select step_index, attempt, verdict from step_runs
     where pipeline_run_id = $1 and verdict is not null order by ended_at`,
    [run.id],
  );
  const summary =
    stepVerdicts.rows[stepVerdicts.rows.length - 1]?.verdict.summary ?? 'completed';

  // Archive pipeline/ artifacts to the run record, then clear them off the
  // branch so the PR diff carries only real code — main never sees pipeline/.
  const archived = await archiveRunArtifacts(run.id, run.branch);
  if (archived.length > 0) {
    try {
      for (const name of archived) {
        await github.deleteFile(run.branch, `pipeline/${name}`, `pipeline: archive artifacts for run ${run.id}`);
      }
    } catch (err) {
      console.error(`artifact branch-clear failed for run ${run.id}: ${String(err)}`);
    }
  }

  // The human reviews code via a PR (spec §9: needs-review = PR awaiting human).
  // Deterministic bookkeeping, so the runner opens it — never a step agent.
  let prUrl: string | null = null;
  try {
    const issueTitle =
      run.issue_number !== null
        ? (
            await query<{ title: string }>('select title from issue_cache where number = $1', [
              run.issue_number,
            ])
          ).rows[0]?.title
        : null;
    const title =
      run.issue_number !== null
        ? `#${run.issue_number}: ${issueTitle ?? run.brief.slice(0, 60)}`
        : run.brief.slice(0, 72);
    const verdictLines = stepVerdicts.rows
      .map((r) => {
        const name = run.definition_snapshot.steps[r.step_index]?.name ?? `step ${r.step_index}`;
        return `- ${name} (attempt ${r.attempt}): ${r.verdict.status} — ${r.verdict.summary}`;
      })
      .join('\n');
    const body = [
      run.brief,
      '',
      `Pipeline \`${run.pipeline_name}\` · run \`${run.id}\``,
      verdictLines,
      '',
      `Artifacts (plan, review) are archived on the run record: GET /runs/${run.id}/artifacts/<name>.`,
      ...(run.issue_number !== null ? ['', `Closes #${run.issue_number}`] : []),
    ].join('\n');
    prUrl = await github.ensurePullRequest(run.branch, title, body);
  } catch (err) {
    // A run without a PR is still a completed run — surface, don't fail.
    console.error(`PR creation failed for run ${run.id}: ${String(err)}`);
  }

  if (run.issue_number !== null) {
    await query(
      `update issue_cache set board_status = 'needs-review', active_run_id = null,
         linked_pr = coalesce($2, linked_pr) where number = $1`,
      [run.issue_number, prUrl],
    );
  }
  await notify({
    event: 'run-completed',
    pipelineRunId: run.id,
    summary: `${run.pipeline_name}${run.issue_number !== null ? ` #${run.issue_number}` : ''} completed: ${summary}${prUrl ? ` · PR: ${prUrl}` : ''}`.slice(0, 500),
  });
}
