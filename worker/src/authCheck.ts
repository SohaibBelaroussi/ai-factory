import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeExecutable } from './cli.js';

/**
 * Substrate AUTH_OK test (Phase 0 gate). Runs one trivial, tool-less turn
 * against the subscription OAuth token and reports one of:
 *   exit 0  AUTH_OK           — real completion with nonzero cost
 *   exit 2  AUTH_FAIL         — token missing/invalid. NOTE: auth failure is
 *                               IN-BAND: the CLI returns "Not logged in" as a
 *                               successful result with $0 cost, so detection is
 *                               result text + zero cost, never the exit code.
 *   exit 1  AUTH_INDETERMINATE — anything else (dumps the result for a human)
 */
export async function runAuthCheck(): Promise<never> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('AUTH_FAIL: CLAUDE_CODE_OAUTH_TOKEN is not set in the environment');
    process.exit(2);
  }

  const model = process.env.WORKER_MODEL ?? 'claude-haiku-4-5-20251001';
  const cliPath = resolveClaudeExecutable();
  console.log(`auth-check: model=${model} cli=${cliPath} cwd=/work`);

  type AuthResult = { subtype?: string; result?: string; total_cost_usd?: number; session_id?: string };
  let result: AuthResult | null = null;

  const stream = query({
    prompt: 'Reply with exactly: AUTH_OK',
    options: {
      model,
      cwd: '/work',
      pathToClaudeCodeExecutable: cliPath,
      maxTurns: 1,
      allowedTools: [],
    },
  });

  try {
    for await (const message of stream) {
      const m = message as { type?: string } & AuthResult;
      if (m.type === 'result') result = m;
    }
  } catch (err) {
    // Newer SDK/CLI versions surface an invalid token as a thrown stream error
    // instead of (or in addition to) the in-band $0 "Not logged in" result.
    const msg = String(err);
    if (/failed to authenticate|not logged in|invalid api key|authentication_error|401|oauth.*(invalid|expired|revoked)/i.test(msg)) {
      console.error(`AUTH_FAIL: ${msg.slice(0, 300)}`);
      process.exit(2);
    }
    console.error(`AUTH_INDETERMINATE: SDK stream failed: ${msg}`);
    process.exit(1);
  }

  if (!result) {
    console.error('AUTH_INDETERMINATE: no result message received');
    process.exit(1);
  }

  const text = result.result ?? '';
  const cost = result.total_cost_usd ?? 0;

  const authFailurePattern = /not logged in|invalid api key|please run \/login|authentication_error|oauth token.*(invalid|expired|revoked)/i;
  if (authFailurePattern.test(text) && cost === 0) {
    console.error(`AUTH_FAIL: in-band auth failure detected (cost=$0): ${text.slice(0, 300)}`);
    process.exit(2);
  }

  if (result.subtype === 'success' && /AUTH_OK/.test(text) && cost > 0) {
    console.log(`AUTH_OK (session=${result.session_id}, cost=$${cost.toFixed(6)})`);
    process.exit(0);
  }

  console.error(
    `AUTH_INDETERMINATE: subtype=${result.subtype} cost=${cost} text=${JSON.stringify(text.slice(0, 300))}`,
  );
  process.exit(1);
}
