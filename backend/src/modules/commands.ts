import { randomBytes } from 'node:crypto';
import { query } from '../db/client.js';
import { EVT, type PipelineRunRow } from '../domain/types.js';
import { inngest } from '../inngest/client.js';
import { assertReady } from './health.js';
import { getPipeline } from './pipelines.js';
import * as github from './github.js';
import * as provisioner from './provisioner.js';

/**
 * Command functions — the single code path per action. API routes, Master
 * tools, and webhook mappers are thin wrappers around these.
 */

/** Structured refusal: data, not an error string. HTTP maps it to 409. */
export class RefusalError extends Error {
  constructor(public readonly refusal: Record<string, unknown>) {
    super(`refused: ${String(refusal.reason)}`);
  }
}

async function computeBlockedBy(issueNumber: number): Promise<number[]> {
  const res = await query<{ blocked_by: number[] }>(
    'select blocked_by from issue_cache where number = $1',
    [issueNumber],
  );
  const deps = res.rows[0]?.blocked_by ?? [];
  if (deps.length === 0) return [];
  const done = await query<{ number: number }>(
    `select number from issue_cache where number = any($1) and board_status = 'completed'`,
    [deps],
  );
  const satisfied = new Set(done.rows.map((r) => r.number));
  return deps.filter((d) => !satisfied.has(d));
}

export async function spawnRun(args: {
  pipeline: string;
  issueNumber?: number | null;
  brief: string;
  createdBy: 'chat' | 'webhook' | 'schedule' | 'api';
  idempotencyKey?: string;
  force?: boolean;
}): Promise<{ runId: string; existing: boolean }> {
  await assertReady();

  const def = await getPipeline(args.pipeline);
  if (!def) throw new RefusalError({ reason: 'unknown_pipeline', pipeline: args.pipeline });
  if (!def.enabled) throw new RefusalError({ reason: 'pipeline_disabled', pipeline: args.pipeline });
  if (!args.brief?.trim()) throw new RefusalError({ reason: 'brief_required' });
  const issueNumber = args.issueNumber ?? null;
  if (def.inputSchema.issueNumber === 'required' && issueNumber === null) {
    throw new RefusalError({ reason: 'issue_required', pipeline: args.pipeline });
  }

  if (args.idempotencyKey) {
    const existing = await query<{ id: string }>(
      'select id from pipeline_runs where idempotency_key = $1',
      [args.idempotencyKey],
    );
    if (existing.rows[0]) return { runId: existing.rows[0].id, existing: true };
  }

  if (issueNumber !== null) {
    const active = await query<{ id: string }>(
      `select id from pipeline_runs where issue_number = $1 and status in ('running','waiting-human')`,
      [issueNumber],
    );
    if (active.rows[0]) {
      throw new RefusalError({ reason: 'already_running', runId: active.rows[0].id });
    }
    if (!args.force) {
      const missing = await computeBlockedBy(issueNumber);
      if (missing.length > 0) throw new RefusalError({ reason: 'blocked', blockedBy: missing });
    }
  }

  const branch = issueNumber !== null ? `issue-${issueNumber}` : `task-${randomBytes(4).toString('hex')}`;

  const res = await query<{ id: string }>(
    `insert into pipeline_runs
       (pipeline_id, pipeline_name, definition_snapshot, issue_number, branch, brief,
        created_by, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      def.id,
      def.name,
      JSON.stringify(def),
      issueNumber,
      branch,
      args.brief.trim(),
      args.createdBy,
      args.idempotencyKey ?? null,
    ],
  );
  if (!res.rows[0]) {
    // Lost an idempotency race — return the winner.
    const winner = await query<{ id: string }>(
      'select id from pipeline_runs where idempotency_key = $1',
      [args.idempotencyKey],
    );
    return { runId: winner.rows[0]!.id, existing: true };
  }
  const runId = res.rows[0].id;

  if (issueNumber !== null) {
    let title = `#${issueNumber}`;
    try {
      const issue = await github.getIssue(issueNumber);
      if (issue) title = issue.title;
    } catch {
      // cache title is cosmetic; sync hardens it in Phase 2
    }
    await query(
      `insert into issue_cache (number, title, board_status, active_run_id)
       values ($1, $2, 'in-progress', $3)
       on conflict (number) do update
         set board_status = 'in-progress', active_run_id = $3, synced_at = now()`,
      [issueNumber, title, runId],
    );
  }

  await inngest.send({ name: EVT.runRequested, data: { runId } });
  return { runId, existing: false };
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await query<PipelineRunRow>('select * from pipeline_runs where id = $1', [runId]);
  const run = res.rows[0];
  if (!run) throw new RefusalError({ reason: 'unknown_run', runId });
  if (!['running', 'waiting-human'].includes(run.status)) {
    throw new RefusalError({ reason: 'not_cancellable', status: run.status });
  }

  const live = await query<{ id: string; container_id: string | null }>(
    `select id, container_id from step_runs
     where pipeline_run_id = $1 and status in ('running','validating','waiting-human')`,
    [runId],
  );
  for (const s of live.rows) {
    if (s.container_id) {
      await provisioner.killWorker(s.container_id);
      await provisioner.removeWorker(s.container_id, s.id);
    }
    await query(
      `update step_runs set status = 'failed', ended_at = now(), internal_token_hash = null where id = $1`,
      [s.id],
    );
  }

  await query(
    `update pipeline_runs set status = 'cancelled', ended_at = now() where id = $1`,
    [runId],
  );
  if (run.issue_number !== null) {
    await query('update issue_cache set active_run_id = null where number = $1', [run.issue_number]);
  }
  // Stops the durable function via cancelOn.
  await inngest.send({ name: EVT.runCancelled, data: { runId } });
}
