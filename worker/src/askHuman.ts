import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * ask_human: a tool from the agent's perspective, suspend/resume from the
 * infrastructure's. The handler files the Question through the internal API
 * (which enforces the cap and flips statuses to waiting-human), then arms the
 * suspend: the main loop persists the session JSONL, emits the one
 * step.waiting_human-outcome event, and exits the process. The answer arrives
 * as the next user message when a fresh worker resumes the session.
 */

export type SuspendState = { questionId: string };

export function buildAskHumanServer(args: {
  internalUrl: string;
  internalToken: string;
  stepRunId: string;
  getSessionId: () => string | undefined;
  onSuspend: (s: SuspendState) => void;
}) {
  const askHuman = tool(
    'ask_human',
    'Ask the human operator a question and PAUSE this session until they answer. Use only for decisions you cannot make yourself — prefer deciding. The answer arrives as the next user message after the pause.',
    {
      body: z.string().describe('The question for the human. Be specific and self-contained.'),
      choices: z.array(z.string()).optional().describe('Optional multiple-choice options.'),
    },
    async ({ body, choices }) => {
      const res = await fetch(`${args.internalUrl}/internal/steps/${args.stepRunId}/question`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${args.internalToken}`,
        },
        body: JSON.stringify({
          kind: choices && choices.length > 0 ? 'multiple-choice' : 'text',
          body,
          choices,
          sessionId: args.getSessionId(),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        questionId?: string;
        remaining?: number;
        error?: { code?: string };
      };
      if (res.status === 409 || json.error?.code === 'cap_exceeded') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'ask_human cap reached for this step — no more questions allowed. Decide yourself and proceed (or finish with an honest verdict).',
            },
          ],
        };
      }
      if (!res.ok || !json.questionId) {
        return {
          content: [
            { type: 'text' as const, text: `ask_human failed (${res.status}) — decide yourself and proceed.` },
          ],
        };
      }
      args.onSuspend({ questionId: json.questionId });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Question ${json.questionId} submitted to the human. This session is PAUSING now — stop working; the answer will arrive as the next user message when the session resumes.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({ name: 'factory', version: '1.0.0', tools: [askHuman] });
}
