import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeExecutable } from './cli.js';
import { isAuthFailureText } from './authDetect.js';
import { cloneBranch, persistAndPush, commitsSince } from './gitOps.js';
import { InternalApi } from './internalApi.js';
import { buildAskHumanServer, type SuspendState } from './askHuman.js';

/**
 * Step execution mode. Lifecycle (architecture-expanded §5): clone branch →
 * restore session JSONL if resuming → SDK query() with the three prompt
 * layers → stream logs + cost to the internal API → commit/persist → emit
 * exactly ONE event to Inngest → die. On ask_human: persist JSONL to the
 * session store, emit the waiting_human outcome, exit — nothing runs and
 * nothing costs money until the answer resumes a fresh worker with the SAME
 * session id.
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
  resumeSessionId?: string;
  resumePrompt?: string;
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

function sessionFilePath(sessionId: string): string {
  const home = process.env.HOME ?? '/home/worker';
  // Session files are keyed by encoded cwd; canonical /work → "-work".
  return join(home, '.claude', 'projects', '-work', `${sessionId}.jsonl`);
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

  let sessionId: string | undefined = ctx.resumeSessionId;
  let baseSha = '';
  let suspendState: SuspendState | null = null;
  let suspendAbortArmed = false;
  let timedOut = false;
  const abort = new AbortController();
  const killTimer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, ctx.timeoutMinutes * 60_000);
  killTimer.unref?.();

  try {
    api.pushLog({
      type: 'worker',
      text: `step ${ctx.stepName} attempt ${ctx.attempt} ${ctx.resumeSessionId ? `resuming session ${ctx.resumeSessionId}` : 'starting'}`,
    });
    baseSha = await cloneBranch(ctx.repo, ctx.branch, gitToken);
    api.pushLog({ type: 'worker', text: `cloned ${ctx.branch} at ${baseSha}` });

    // Resume: restore the suspended session JSONL under the canonical cwd key.
    let prompt = ctx.runtimeContext;
    if (ctx.resumeSessionId) {
      const stored = await api.downloadSession();
      if (!stored) throw new Error('resume requested but session store returned nothing');
      const file = sessionFilePath(ctx.resumeSessionId);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, stored.jsonl, 'utf8');
      prompt = ctx.resumePrompt ?? 'The human has answered. Continue the step.';
      api.pushLog({ type: 'worker', text: `restored session JSONL (${stored.jsonl.length} bytes)` });
    }

    const askHumanGranted = ctx.allowedTools.includes('ask_human');
    const sdkTools = ctx.allowedTools.filter((t) => t !== 'ask_human');
    if (askHumanGranted) sdkTools.push('mcp__factory__ask_human');
    const mcpServers = askHumanGranted
      ? {
          factory: buildAskHumanServer({
            internalUrl,
            internalToken,
            stepRunId: ctx.stepRunId,
            getSessionId: () => sessionId,
            onSuspend: (s) => {
              suspendState = s;
            },
          }),
        }
      : undefined;

    let result: ResultMsg | null = null;
    const stream = query({
      prompt,
      options: {
        systemPrompt: [ctx.harnessPrompt, ctx.behaviorPrompt],
        model: ctx.model,
        cwd: '/work',
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        allowedTools: sdkTools,
        ...(mcpServers ? { mcpServers } : {}),
        permissionMode: 'dontAsk',
        outputFormat: { type: 'json_schema', schema: VERDICT_SCHEMA },
        abortController: abort,
        ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
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
      // After ask_human fires, let the tool result reach the transcript, then
      // cut the session — the model must not keep working past the pause.
      if (suspendState && !suspendAbortArmed && m.type === 'user') {
        suspendAbortArmed = true;
        setTimeout(() => abort.abort(), 700);
      }
    }
    await finishAfterStream(result);
  } catch (err) {
    if (suspendState) {
      await suspend(suspendState);
    } else {
      const msg = String(err);
      if (timedOut) {
        await emitOnce({ outcome: 'failed', error: `worker self-timeout after ${ctx.timeoutMinutes}m`, sessionId });
      } else if (isAuthFailureText(msg)) {
        await emitOnce({ outcome: 'failed', error: `auth failure: ${msg.slice(0, 200)}`, authFailure: true, sessionId });
      } else {
        await emitOnce({ outcome: 'failed', error: msg.slice(0, 500), sessionId });
      }
    }
    process.exit(0);
  }
  process.exit(0);

  async function finishAfterStream(result: ResultMsg | null): Promise<void> {
    // The stream can also end cleanly right after an ask (abort raced the end).
    if (suspendState) {
      await suspend(suspendState);
      return;
    }
    if (!result) throw new Error('session ended without a result message');
    if (result.session_id) sessionId = result.session_id;

    const text = result.result ?? '';
    const cost = result.total_cost_usd ?? 0;
    await api.postCost(cost);

    if (isAuthFailureText(text) && cost === 0) {
      await emitOnce({ outcome: 'failed', error: `auth failure (in-band): ${text.slice(0, 200)}`, authFailure: true, sessionId });
      return;
    }
    if (result.subtype && result.subtype !== 'success') {
      await emitOnce({ outcome: 'failed', error: `session ended: ${result.subtype}`, sessionId });
      return;
    }

    const verdict = result.structured_output ?? parseVerdictFence(text);
    await persistAndPush(ctx.branch, `${ctx.stepName} (attempt ${ctx.attempt}): persist step output`);
    const commitShas = await commitsSince(baseSha);
    await emitOnce({ outcome: 'done', verdict, commitShas, sessionId });
  }

  async function suspend(s: SuspendState): Promise<void> {
    // Persist partial work to the branch — the workspace dies with us.
    try {
      await persistAndPush(ctx.branch, `${ctx.stepName} (attempt ${ctx.attempt}): work in progress before ask_human`);
    } catch {
      // best-effort; the session JSONL is the critical survivor
    }
    if (sessionId) {
      try {
        const jsonl = await readFile(sessionFilePath(sessionId), 'utf8');
        const ok = await api.uploadSession(sessionId, jsonl);
        api.pushLog({ type: 'worker', text: `session persisted on ask_human (${ok ? 'ok' : 'FAILED'})` });
      } catch (err) {
        api.pushLog({ type: 'worker', text: `session persist FAILED: ${String(err).slice(0, 200)}` });
      }
    }
    await emitOnce({ outcome: 'waiting_human', questionId: s.questionId, sessionId });
  }
}
