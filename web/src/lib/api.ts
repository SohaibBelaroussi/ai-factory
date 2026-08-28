import { streamSse } from './sse';
import type {
  ApiErrorBody,
  BoardRow,
  ChatMessage,
  ChatRow,
  ChatTurnEvent,
  Health,
  IssueDetail,
  LogRow,
  NotificationRow,
  PipelineDefinition,
  PipelineInput,
  QuestionListRow,
  RunDetail,
  RunListItem,
  SettingRow,
} from './types';

/**
 * Typed client for the public API. Everything goes through the /api prefix
 * (stripped by the dev proxy / nginx) — one origin, no CORS. Every call here
 * is reproducible with curl against backend :3000; the UI adds nothing.
 */

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';
const TOKEN_KEY = 'operatorToken';

export function getOperatorToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setOperatorToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — requests just go out unauthenticated
  }
}

export function authHeaders(): Record<string, string> {
  const token = getOperatorToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 409s are structured refusals — data, not errors, but thrown for flow control. */
export class Refusal extends Error {
  constructor(public readonly refusal: Record<string, unknown>) {
    super(`refused: ${String(refusal.reason ?? 'unknown')}`);
  }
}

async function req<T>(
  path: string,
  init?: RequestInit & { headers?: Record<string, string> },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const parse = (): unknown => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  if (res.status === 409) throw new Refusal((parse() as Record<string, unknown>) ?? {});
  if (!res.ok) {
    const body = parse() as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `HTTP ${res.status}`,
      body?.error?.details,
    );
  }
  return parse() as T;
}

// ---------- health / settings ----------

export const getHealth = (): Promise<Health> => req('/health');
export const getSettings = (): Promise<SettingRow[]> => req('/settings');
export const putSetting = (key: string, value: string): Promise<{ key: string; set: boolean }> =>
  req(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });

// ---------- pipelines ----------

export const listPipelines = (): Promise<PipelineDefinition[]> => req('/pipelines');
export const getPipeline = (id: string): Promise<PipelineDefinition> => req(`/pipelines/${id}`);
export const createPipeline = (body: PipelineInput): Promise<PipelineDefinition> =>
  req('/pipelines', { method: 'POST', body: JSON.stringify(body) });
export const updatePipeline = (id: string, body: PipelineInput): Promise<PipelineDefinition> =>
  req(`/pipelines/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const disablePipeline = (id: string): Promise<{ disabled: boolean }> =>
  req(`/pipelines/${id}/disable`, { method: 'POST', body: '{}' });

// ---------- runs ----------

export const listRuns = (opts?: { active?: boolean; limit?: number }): Promise<RunListItem[]> => {
  const q = new URLSearchParams();
  if (opts?.active) q.set('active', 'true');
  if (opts?.limit) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return req(`/runs${qs ? `?${qs}` : ''}`);
};

export const getRun = (id: string): Promise<RunDetail> => req(`/runs/${id}`);

export const spawnRun = (
  body: { pipeline: string; issueNumber?: number; brief: string; force?: boolean },
  idempotencyKey?: string,
): Promise<{ runId: string }> =>
  req('/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  });

export const cancelRun = (id: string): Promise<{ cancelled: boolean }> =>
  req(`/runs/${id}/cancel`, { method: 'POST', body: '{}' });

export const getArtifact = async (runId: string, name: string): Promise<string> => {
  const res = await fetch(`${BASE}/runs/${runId}/artifacts/${name}`, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, 'not_found', `artifact ${name} not found`);
  return res.text();
};

export const getLogs = (
  runId: string,
  opts?: { step?: number; after?: number; limit?: number },
): Promise<LogRow[]> => {
  const q = new URLSearchParams();
  if (opts?.step !== undefined) q.set('step', String(opts.step));
  if (opts?.after !== undefined) q.set('after', String(opts.after));
  if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return req(`/runs/${runId}/logs${qs ? `?${qs}` : ''}`);
};

// ---------- board / issues ----------

export const getBoard = (): Promise<BoardRow[]> => req('/board');
export const getIssue = (n: number): Promise<IssueDetail> => req(`/issues/${n}`);

// ---------- questions / notifications ----------

export const listQuestions = (status: 'open' | 'answered' = 'open'): Promise<QuestionListRow[]> =>
  req(`/questions?status=${status}`);
export const answerQuestion = (id: string, answer: string): Promise<{ answered: boolean }> =>
  req(`/questions/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) });

export const listNotifications = (opts?: {
  unread?: boolean;
  limit?: number;
}): Promise<NotificationRow[]> => {
  const q = new URLSearchParams();
  if (opts?.unread) q.set('unread', 'true');
  if (opts?.limit) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return req(`/notifications${qs ? `?${qs}` : ''}`);
};
export const markNotificationsRead = (
  body: { ids: string[] } | { all: true },
): Promise<{ marked: number }> =>
  req('/notifications/read', { method: 'POST', body: JSON.stringify(body) });

// ---------- chats ----------

export const createChat = (): Promise<{ chatId: string }> =>
  req('/chats', { method: 'POST', body: '{}' });
export const listChats = (): Promise<ChatRow[]> => req('/chats');
export const getChatMessages = (id: string): Promise<ChatMessage[]> => req(`/chats/${id}/messages`);

/** Send a user turn; events stream back until 'done' or 'error'. */
export async function sendChatMessage(
  chatId: string,
  message: string,
  onEvent: (e: ChatTurnEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  await streamSse(`${BASE}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ message }),
    signal,
    onMessage: (msg) => {
      try {
        const data = JSON.parse(msg.data) as Record<string, unknown>;
        onEvent({ type: msg.event, ...data } as ChatTurnEvent);
      } catch {
        // malformed frame — skip
      }
    },
  });
}

export const API_BASE = BASE;
