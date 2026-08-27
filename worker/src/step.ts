import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeExecutable } from './cli.js';
import { isAuthFailureText } from './authDetect.js';
import { cloneBranch, persistAndPush, commitsSince } from './gitOps.js';
import { InternalApi } from './internalApi.js';

/**
 * Step execution mode. Lifecycle (architecture-expanded §5): clone branch →
 * [Phase 3: restore session] → SDK query() with the three prompt layers →
 * stream logs + cost to the internal API → persist commits/artifacts → emit
 * exactly ONE event to Inngest → die. Dumb by design: no routing decisions.
 */

type StepContext = {
  stepRunId: string;
  runId: string;
  branch: string;
  repo: string;
  stepName: string;
  stepIndex: number;
  attempt: number;
  harnessPrompt: string;
  behaviorPrompt: string;
  runtimeContext: string;
  allowedTools: string[];
  model: string;
  outputArtifact: string | null;
  timeoutMinutes: number;
  askHumanCap: number;
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed', 'reject'] },
    summary: { type: 'string', description: 'One line. Feeds the status board.' },
    detailsArtifact: { type: 'string', description: 'Optional pipeline/ artifact with full reasoning.' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
};

type ResultMsg = {
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  structured_output?: unknown;
};

function parseVerdictFence(text: string): unknown {
  const m = /```verdict\s+status:\s*(done|failed|reject)\s+summary:\s*([^\n`]+)/.exec(text);
  return m ? { status: m[1], summary: m[2]!.trim() } : null;
}

export async function runStep(): Promise<never> {
  const raw = process.env.STEP_CONTEXT;
  const gitToken = process.env.GIT_TOKEN;
  const internalToken = process.env.INTERNAL_TOKEN;
  const internalUrl = process.env.INTERNAL_API_URL;
  const inngestEventUrl = process.env.INNGEST_EVENT_URL;
  if (!raw || !gitToken || !internalToken || !internalUrl || !inngestEventUrl || !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('step mode: missing required env (STEP_CONTEXT, GIT_TOKEN, INTERNAL_TOKEN, INTERNAL_API_URL, INNGEST_EVENT_URL, CLAUDE_CODE_OAUTH_TOKEN)');
    process.exit(64);
  }
  const ctx = JSON.parse(raw) as StepContext;
  const api = new InternalApi({
    internalUrl,
    internalToken,
    stepRunId: ctx.stepRunId,
    inngestEventUrl,
  });

  let emitted = false;
  const emitOnce = async (data: Record<string, unknown>): Promise<void> => {
    if (emitted) return;
    emitted = true;
    await api.flushLogs();
    await api.emitEvent('step.finished', { runId: ctx.runId, stepRunId: ctx.stepRunId, ...data });
  };

  let sessionId: string | undefined;
  let timedOut = false;
  const abort = new AbortController();
  const killTimer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, ctx.timeoutMinutes * 60_000);
  killTimer.unref?.();

  try {
    api.pushLog({ type: 'worker', text: `step ${ctx.stepName} attempt ${ctx.attempt} starting` });
    const baseSha = await cloneBranch(ctx.repo, ctx.branch, gitToken);
    api.pushLog({ type: 'worker', text: `cloned ${ctx.branch} at ${baseSha}` });

    // ask_human is a factory tool (Phase 3), not an SDK tool.
    const sdkTools = ctx.allowedTools.filter((t) => t !== 'ask_human');

    let result: ResultMsg | null = null;
    const stream = query({
      prompt: ctx.runtimeContext,
      options: {
        // Layers 1+2 as the system prompt (stable prefix); layer 3 is the message.
        systemPrompt: [ctx.harnessPrompt, ctx.behaviorPrompt],
        model: ctx.model,
        cwd: '/work',
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        allowedTools: sdkTools,
        permissionMode: 'dontAsk',
        outputFormat: { type: 'json_schema', schema: VERDICT_SCHEMA },
        abortController: abort,
        // Least privilege: the agent's tool env never sees GIT_TOKEN or
        // INTERNAL_TOKEN (git push auth is embedded in the remote URL).
        env: {
          HOME: process.env.HOME ?? '/home/worker',
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
        },
      },
    });

    for await (const message of stream) {
      const m = message as { type?: string; subtype?: string; session_id?: string } & ResultMsg;
      api.pushLog(m);
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) sessionId = m.session_id;
      if (m.type === 'result') result = m;
    }

    if (!result) throw new Error('session ended without a result message');
    if (result.session_id) sessionId = result.session_id;

    const text = result.result ?? '';
    const cost = result.total_cost_usd ?? 0;
    await api.postCost(cost);

    if (isAuthFailureText(text) && cost === 0) {
      await emitOnce({ outcome: 'failed', error: `auth failure (in-band): ${text.slice(0, 200)}`, authFailure: true, sessionId });
      process.exit(0);
    }
    if (result.subtype && result.subtype !== 'success') {
      await emitOnce({ outcome: 'failed', error: `session ended: ${result.subtype}`, sessionId });
      process.exit(0);
    }

    const verdict = result.structured_output ?? parseVerdictFence(text);
    // Persist whatever the agent produced, even with a bad verdict — the
    // branch is the audit trail either way.
    await persistAndPush(ctx.branch, `${ctx.stepName} (attempt ${ctx.attempt}): persist step output`);
    const commitShas = await commitsSince(baseSha);

    await emitOnce({ outcome: 'done', verdict, commitShas, sessionId });
    process.exit(0);
  } catch (err) {
    const msg = String(err);
    if (timedOut) {
      await emitOnce({ outcome: 'failed', error: `worker self-timeout after ${ctx.timeoutMinutes}m`, sessionId });
    } else if (isAuthFailureText(msg)) {
      await emitOnce({ outcome: 'failed', error: `auth failure: ${msg.slice(0, 200)}`, authFailure: true, sessionId });
    } else {
      await emitOnce({ outcome: 'failed', error: msg.slice(0, 500), sessionId });
    }
    process.exit(0);
  }
}
