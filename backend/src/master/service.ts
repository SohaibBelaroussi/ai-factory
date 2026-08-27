import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { getSetting } from '../modules/settings.js';
import { resolveClaudeExecutable } from '../modules/cli.js';
import { MASTER_SYSTEM_PROMPT } from './prompt.js';
import { buildFactoryMcpServer, FACTORY_TOOL_NAMES } from './tools.js';

/**
 * Master service: one SDK session per conversation, resume by session id,
 * chat mirrored to the DB as it streams (the mirror powers history; the
 * session JSONL — kept under the session-store volume — powers resume and is
 * never parsed). All built-in tools stripped: the Master can only act through
 * factory tools.
 */

const DISALLOWED_BUILTINS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'BashOutput', 'KillShell', 'ExitPlanMode',
];

export type TurnEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool.use'; name: string; input: unknown }
  | { type: 'done'; sessionId: string | null }
  | { type: 'error'; message: string };

const busyConversations = new Set<string>();

async function mirror(conversationId: string, role: string, content: string): Promise<void> {
  await query('insert into chat_messages (conversation_id, role, content) values ($1, $2, $3)', [
    conversationId,
    role,
    content,
  ]);
}

export async function runMasterTurn(
  conversationId: string,
  userMessage: string,
  onEvent: (e: TurnEvent) => void,
): Promise<void> {
  if (busyConversations.has(conversationId)) {
    onEvent({ type: 'error', message: 'a turn is already in progress for this conversation' });
    return;
  }
  busyConversations.add(conversationId);
  try {
    const conv = await query<{ id: string; sdk_session_id: string | null; title: string }>(
      'select id, sdk_session_id, title from chat_conversations where id = $1',
      [conversationId],
    );
    if (!conv.rows[0]) {
      onEvent({ type: 'error', message: 'no such conversation' });
      return;
    }

    const claudeToken = await getSetting('claude-oauth-token');
    if (!claudeToken) {
      onEvent({ type: 'error', message: 'claude-oauth-token is not set (PUT /settings/claude-token)' });
      return;
    }

    await mirror(conversationId, 'user', userMessage);

    // Canonical, volume-backed cwd + HOME: sessions survive backend restarts.
    const masterCwd = join(config.sessionStoreDir, 'master');
    const masterHome = join(config.sessionStoreDir, 'home');
    await mkdir(masterCwd, { recursive: true });
    await mkdir(masterHome, { recursive: true });

    let sessionId: string | null = conv.rows[0].sdk_session_id;

    const stream = sdkQuery({
      prompt: userMessage,
      options: {
        systemPrompt: MASTER_SYSTEM_PROMPT,
        model: config.masterModel,
        cwd: masterCwd,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        mcpServers: { factory: buildFactoryMcpServer() },
        allowedTools: FACTORY_TOOL_NAMES,
        disallowedTools: DISALLOWED_BUILTINS,
        permissionMode: 'dontAsk',
        maxTurns: 40,
        ...(sessionId ? { resume: sessionId } : {}),
        env: {
          HOME: masterHome,
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
        },
      },
    });

    for await (const message of stream) {
      const m = message as {
        type?: string;
        subtype?: string;
        session_id?: string;
        message?: { content?: ({ type?: string; text?: string; name?: string; input?: unknown })[] };
      };
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        sessionId = m.session_id;
        await query('update chat_conversations set sdk_session_id = $2 where id = $1', [
          conversationId,
          sessionId,
        ]);
      }
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            await mirror(conversationId, 'assistant', block.text);
            onEvent({ type: 'assistant', text: block.text });
          } else if (block.type === 'tool_use') {
            const summary = JSON.stringify({ name: block.name, input: block.input });
            await mirror(conversationId, 'tool', summary);
            onEvent({ type: 'tool.use', name: block.name ?? 'unknown', input: block.input });
          }
        }
      }
    }

    await query(
      `update chat_conversations set last_message_at = now(),
         title = case when title = 'New conversation' then left($2, 80) else title end
       where id = $1`,
      [conversationId, userMessage],
    );
    onEvent({ type: 'done', sessionId });
  } catch (err) {
    const msg = String(err).slice(0, 500);
    await mirror(conversationId, 'system', `error: ${msg}`).catch(() => {});
    onEvent({ type: 'error', message: msg });
  } finally {
    busyConversations.delete(conversationId);
  }
}
