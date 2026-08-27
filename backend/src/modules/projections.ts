import { query } from '../db/client.js';
import type { PipelineRunRow, Verdict } from '../domain/types.js';
import * as github from './github.js';
import { parseBlockedBy } from './issueSync.js';

/**
 * Read-model projections of the Status DB. The board, the runs list, and the
 * Master's read tools all render from these — reads are projections, writes
 * are commands (backend-api.md design rule 3).
 */

export type BoardRow = {
  number: number;
  title: string;
  boardStatus: string;
  blockedBy: number[];
  activeRunId: string | null;
  linkedPr: string | null;
};

export async function getBoard(): Promise<BoardRow[]> {
  const res = await query<{
    number: number;
    title: string;
    board_status: string;
    blocked_by: number[];
    active_run_id: string | null;
    linked_pr: string | null;
  }>('select * from issue_cache order by number');
  return res.rows.map((r) => ({
    number: r.number,
    title: r.title,
    boardStatus: r.board_status,
    blockedBy: r.blocked_by,
    activeRunId: r.active_run_id,
    linkedPr: r.linked_pr,
  }));
}

export async function listRuns(activeOnly: boolean, limit = 50): Promise<unknown[]> {
  const runs = await query<PipelineRunRow>(
    `select * from pipeline_runs
     ${activeOnly ? `where status in ('running','waiting-human')` : ''}
     order by created_at desc limit $1`,
    [Math.min(limit, 200)],
  );
  const out = [];
  for (const run of runs.rows) {
    const stepCount = run.definition_snapshot.steps.length;
    const stepName = run.definition_snapshot.steps[run.current_step_index]?.name ?? 'unknown';
    const lastVerdict = await query<{ verdict: Verdict }>(
      `select verdict from step_runs where pipeline_run_id = $1 and verdict is not null
       order by ended_at desc limit 1`,
      [run.id],
    );
    const pendingQ = await query<{ body: string }>(
      `select body from questions where pipeline_run_id = $1 and status = 'open' limit 1`,
      [run.id],
    );
    out.push({
      id: run.id,
      pipeline: run.pipeline_name,
      issueNumber: run.issue_number,
      branch: run.branch,
      status: run.status,
      currentStep: `${run.current_step_index + 1}/${stepCount}: ${stepName}`,
      startedAt: run.created_at,
      endedAt: run.ended_at,
      costUsd: run.cost_usd,
      lastVerdictSummary: lastVerdict.rows[0]?.verdict.summary ?? null,
      pendingQuestion: pendingQ.rows[0]?.body ?? null,
    });
  }
  return out;
}

/**
 * Issue detail with dependency satisfaction COMPUTED — the Master never
 * traverses the graph itself.
 */
export async function getIssueDetail(n: number): Promise<unknown | null> {
  const issue = await github.getIssue(n);
  if (!issue) return null;

  const blockedBy = parseBlockedBy(issue.body);
  const satisfied = new Set(
    blockedBy.length > 0
      ? (
          await query<{ number: number }>(
            `select number from issue_cache where number = any($1) and board_status = 'completed'`,
            [blockedBy],
          )
        ).rows.map((r) => r.number)
      : [],
  );
  const missing = blockedBy.filter((d) => !satisfied.has(d));

  const runs = await query<PipelineRunRow>(
    `select * from pipeline_runs where issue_number = $1 order by created_at desc`,
    [n],
  );
  const pastRuns = [];
  for (const run of runs.rows) {
    const lastVerdict = await query<{ verdict: Verdict }>(
      `select verdict from step_runs where pipeline_run_id = $1 and verdict is not null
       order by ended_at desc limit 1`,
      [run.id],
    );
    pastRuns.push({
      id: run.id,
      pipeline: run.pipeline_name,
      status: run.status,
      outcome: lastVerdict.rows[0]?.verdict.summary ?? null,
      createdAt: run.created_at,
      endedAt: run.ended_at,
    });
  }

  let comments: { author: string; body: string }[] = [];
  try {
    comments = await github.getIssueComments(n);
  } catch {
    // comments are optional detail
  }
  const cache = await query<{ linked_pr: string | null; board_status: string }>(
    'select linked_pr, board_status from issue_cache where number = $1',
    [n],
  );

  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    boardStatus: cache.rows[0]?.board_status ?? (issue.state === 'closed' ? 'completed' : 'backlog'),
    dependencies: { blockedBy, satisfied: [...satisfied], missing, blocked: missing.length > 0 },
    linkedBranch: runs.rows.length > 0 ? runs.rows[0]!.branch : null,
    linkedPr: cache.rows[0]?.linked_pr ?? null,
    comments,
    pastRuns,
  };
}

export async function listOpenQuestions(): Promise<unknown[]> {
  const res = await query(
    `select q.id, q.pipeline_run_id, q.kind, q.body, q.choices, q.created_at,
            r.pipeline_name, r.issue_number
     from questions q join pipeline_runs r on r.id = q.pipeline_run_id
     where q.status = 'open' order by q.created_at`,
  );
  return res.rows;
}
