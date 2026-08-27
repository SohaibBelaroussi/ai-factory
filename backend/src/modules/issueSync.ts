import { query } from '../db/client.js';
import * as github from './github.js';

/**
 * IssueCache sync: GitHub → issue_cache projection. GitHub stays authoritative
 * for issue content; board_status and blocked_by are computed here, in code.
 *
 * Dependency convention: the issue body declares blockers with a line like
 *   Blocked-by: #1, #2      (case-insensitive; "blocked by #1 #2" also works)
 */

export function parseBlockedBy(body: string): number[] {
  const m = /blocked[- ]by:?\s*((?:#\d+[,\s]*)+)/i.exec(body);
  if (!m) return [];
  return [...m[1]!.matchAll(/#(\d+)/g)].map((x) => Number(x[1])).filter((n) => n > 0);
}

let lastSyncAt = 0;

/** Sync at most once per maxAgeSeconds; tools call this before reading. */
export async function syncIssuesIfStale(maxAgeSeconds = 60): Promise<void> {
  if (Date.now() - lastSyncAt < maxAgeSeconds * 1000) return;
  await syncIssues();
}

export async function syncIssues(): Promise<number> {
  const issues = await github.listIssues();
  lastSyncAt = Date.now();

  const activeRuns = await query<{ issue_number: number; id: string }>(
    `select issue_number, id from pipeline_runs
     where issue_number is not null and status in ('running','waiting-human')`,
  );
  const activeByIssue = new Map(activeRuns.rows.map((r) => [r.issue_number, r.id]));

  const completedRuns = await query<{ issue_number: number }>(
    `select distinct issue_number from pipeline_runs
     where issue_number is not null and status = 'completed'`,
  );
  const hasCompletedRun = new Set(completedRuns.rows.map((r) => r.issue_number));

  const closed = new Set(issues.filter((i) => i.state === 'closed').map((i) => i.number));

  for (const issue of issues) {
    const blockedBy = parseBlockedBy(issue.body);
    let status: string;
    if (issue.state === 'closed') status = 'completed';
    else if (activeByIssue.has(issue.number)) status = 'in-progress';
    else if (hasCompletedRun.has(issue.number)) status = 'needs-review';
    else if (blockedBy.some((d) => !closed.has(d))) status = 'blocked';
    else status = 'backlog';

    await query(
      `insert into issue_cache (number, title, board_status, blocked_by, active_run_id, raw, synced_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (number) do update set
         title = $2, board_status = $3, blocked_by = $4, active_run_id = $5,
         raw = $6, synced_at = now()`,
      [
        issue.number,
        issue.title,
        status,
        JSON.stringify(blockedBy),
        activeByIssue.get(issue.number) ?? null,
        JSON.stringify({ state: issue.state, labels: issue.labels }),
      ],
    );
  }
  return issues.length;
}
