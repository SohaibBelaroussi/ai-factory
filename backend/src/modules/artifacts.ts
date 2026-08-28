import { query } from '../db/client.js';
import * as github from './github.js';

/**
 * One code path for reading a run's artifact: archive first (runs that ended
 * — survives branch deletion and keeps PRs clean), branch fallback (runs
 * still in flight).
 */
export async function readRunArtifact(runId: string, name: string): Promise<string | null> {
  const archived = await query<{ content: string }>(
    'select content from run_artifacts where pipeline_run_id = $1 and name = $2',
    [runId, name],
  );
  if (archived.rows[0]) return archived.rows[0].content;

  const run = await query<{ branch: string }>('select branch from pipeline_runs where id = $1', [
    runId,
  ]);
  if (!run.rows[0]) return null;
  return github.readFile(run.rows[0].branch, `pipeline/${name}`);
}

/** Best-effort: pull every pipeline/ file off the branch into the archive. */
export async function archiveRunArtifacts(runId: string, branch: string): Promise<string[]> {
  const archived: string[] = [];
  try {
    const names = await github.listPipelineArtifacts(branch);
    for (const name of names) {
      const content = await github.readFile(branch, `pipeline/${name}`);
      if (content === null) continue;
      await query(
        `insert into run_artifacts (pipeline_run_id, name, content) values ($1, $2, $3)
         on conflict (pipeline_run_id, name) do update set content = excluded.content, archived_at = now()`,
        [runId, name, content.slice(0, 2 * 1024 * 1024)],
      );
      archived.push(name);
    }
  } catch (err) {
    console.error(`artifact archive failed for run ${runId}: ${String(err)}`);
  }
  return archived;
}
