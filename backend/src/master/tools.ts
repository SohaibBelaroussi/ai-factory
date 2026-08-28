import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { query } from '../db/client.js';
import { listPipelines } from '../modules/pipelines.js';
import { spawnRun, cancelRun, answerQuestion, RefusalError } from '../modules/commands.js';
import { NotReadyError } from '../modules/health.js';
import { getBoard, getIssueDetail, listRuns, listOpenQuestions } from '../modules/projections.js';
import { syncIssuesIfStale } from '../modules/issueSync.js';
import { readRunArtifact } from '../modules/artifacts.js';
import * as github from '../modules/github.js';

/**
 * The Master's tools — all deterministic code, wrapping the same command
 * functions and projections as the public API (one code path per action).
 * The LLM decides WHAT to do; these decide what is TRUE.
 */

function json(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
}

const listPipelineTypes = tool(
  'list_pipeline_types',
  'List the enabled pipeline types you can spawn: name, description (match the user request against these), and input schema.',
  {},
  async () => {
    const defs = await listPipelines();
    return json(
      defs
        .filter((d) => d.enabled)
        .map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })),
    );
  },
);

const getBoardTool = tool(
  'get_board',
  'The whole project state in one call: every issue with number, title, board status (backlog/in-progress/needs-review/completed/blocked), blockedBy, and activeRunId.',
  {},
  async () => {
    try {
      await syncIssuesIfStale();
    } catch {
      // stale cache beats no answer; sync failures surface in health
    }
    return json(await getBoard());
  },
);

const getIssueTool = tool(
  'get_issue',
  'Full detail for one issue: body, labels, comments, dependencies with satisfaction COMPUTED (blocked + missing list), linked branch/PR, and past runs with outcomes.',
  { number: z.number().int().positive() },
  async ({ number }) => {
    try {
      await syncIssuesIfStale();
    } catch {
      // see above
    }
    const detail = await getIssueDetail(number);
    return json(detail ?? { error: `issue #${number} not found` });
  },
);

const listRunsTool = tool(
  'list_runs',
  'Pipeline runs: id, pipeline, issue, current step ("2/4: review"), status, last verdict summary (one line), pending question text if waiting-human. activeOnly=true for only running/waiting runs.',
  { activeOnly: z.boolean().optional() },
  async ({ activeOnly }) => json(await listRuns(activeOnly ?? false)),
);

const readArtifactTool = tool(
  'read_artifact',
  'Fetch one artifact (e.g. plan.md, review.md) from a run\'s branch. Use only when the user wants detail beyond the verdict summaries.',
  { runId: z.string(), name: z.string() },
  async ({ runId, name }) => {
    if (!/^[\w][\w.-]*$/.test(name)) return json({ error: 'bad artifact name' });
    const content = await readRunArtifact(runId, name);
    return json(content === null ? { error: `artifact ${name} not found` } : { name, content });
  },
);

const listPendingQuestionsTool = tool(
  'list_pending_questions',
  'All open ask_human questions across runs, with the run and issue they belong to.',
  {},
  async () => json(await listOpenQuestions()),
);

const spawnPipelineTool = tool(
  'spawn_pipeline',
  'Dispatch a pipeline. Validates: pipeline enabled, issue not blocked (unless force), no active run on the issue. Returns {runId} or a STRUCTURED REFUSAL ({reason: "blocked", blockedBy:[...]} | {reason: "already_running", runId}) — relay refusals to the user honestly.',
  {
    name: z.string(),
    issueNumber: z.number().int().positive().optional(),
    brief: z.string(),
    force: z.boolean().optional(),
  },
  async ({ name, issueNumber, brief, force }) => {
    try {
      const result = await spawnRun({
        pipeline: name,
        issueNumber: issueNumber ?? null,
        brief,
        force,
        createdBy: 'chat',
      });
      return json({ dispatched: true, runId: result.runId });
    } catch (err) {
      if (err instanceof RefusalError) return json({ dispatched: false, refusal: err.refusal });
      if (err instanceof NotReadyError) {
        return json({
          dispatched: false,
          refusal: { reason: 'factory_not_ready', checks: err.health.checks },
        });
      }
      throw err;
    }
  },
);

const cancelRunTool = tool(
  'cancel_run',
  'Cancel a running or waiting pipeline run. Kills any live worker session.',
  { runId: z.string() },
  async ({ runId }) => {
    try {
      await cancelRun(runId);
      return json({ cancelled: true });
    } catch (err) {
      if (err instanceof RefusalError) return json({ cancelled: false, refusal: err.refusal });
      throw err;
    }
  },
);

const updateIssueTool = tool(
  'update_issue',
  'Board management on a GitHub issue: add a comment and/or replace its labels. Use for legitimate bookkeeping (e.g. noting why something is blocked) — never to do pipeline work.',
  {
    number: z.number().int().positive(),
    comment: z.string().optional(),
    labels: z.array(z.string()).optional(),
  },
  async ({ number, comment, labels }) => {
    if (!comment && !labels) return json({ error: 'nothing to update' });
    if (comment) await github.addIssueComment(number, comment);
    if (labels) await github.setIssueLabels(number, labels);
    try {
      const { syncIssues } = await import('../modules/issueSync.js');
      await syncIssues();
    } catch {
      // cache refresh is best-effort
    }
    return json({ updated: true });
  },
);

const answerQuestionTool = tool(
  'answer_question',
  'Submit the human\'s answer to an open ask_human question (find them with list_pending_questions). This resumes the suspended pipeline step. Only submit what the user actually said — never invent an answer.',
  { questionId: z.string(), answer: z.string() },
  async ({ questionId, answer }) => {
    try {
      await answerQuestion(questionId, answer);
      return json({ answered: true, questionId });
    } catch (err) {
      if (err instanceof RefusalError) return json({ answered: false, refusal: err.refusal });
      throw err;
    }
  },
);

const factoryTools = [
  answerQuestionTool,
  listPipelineTypes,
  getBoardTool,
  getIssueTool,
  listRunsTool,
  readArtifactTool,
  listPendingQuestionsTool,
  spawnPipelineTool,
  cancelRunTool,
  updateIssueTool,
];

export const FACTORY_TOOL_NAMES = factoryTools.map((t) => `mcp__factory__${t.name}`);

export function buildFactoryMcpServer() {
  return createSdkMcpServer({ name: 'factory', version: '1.0.0', tools: factoryTools });
}
