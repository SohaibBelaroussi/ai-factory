import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool';
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task';
import { Shimmer } from '@/components/ai-elements/shimmer';
import {
  createChat,
  getChatMessages,
  listNotifications,
  listRuns,
  sendChatMessage,
} from '../lib/api';
import { timeAgo } from '../lib/format';
import type { ChatTurnEvent } from '../lib/types';

/**
 * The Master chat — the console's home screen. History from the DB mirror,
 * live turns over the SSE POST stream. "/" is a fresh conversation; the
 * first send creates the chat row, exactly like starting a new claude.ai
 * conversation.
 */

const SUGGESTIONS = [
  'What is running right now?',
  'Any pending questions?',
  'Process the board: dispatch every open, unblocked issue.',
  'Summarize the last completed run.',
];

type LiveItem =
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'error'; message: string };

function ToolCard({ name, input }: { name: string; input: unknown }): React.ReactNode {
  return (
    <Tool>
      <ToolHeader
        state="output-available"
        toolName={name.replace(/^mcp__factory__/, '')}
        type="dynamic-tool"
      />
      <ToolContent>
        <ToolInput input={input} />
      </ToolContent>
    </Tool>
  );
}

function statusDot(status: string): string {
  if (status === 'running') return 'bg-blue-500';
  if (status === 'waiting-human') return 'bg-amber-500';
  if (status === 'completed') return 'bg-emerald-500';
  if (status === 'failed') return 'bg-red-500';
  return 'bg-neutral-400';
}

function ActivityRail(): React.ReactNode {
  const runs = useQuery({
    queryKey: ['runs', { activeOnly: true }],
    queryFn: () => listRuns({ active: true, limit: 20 }),
  });
  const notifications = useQuery({
    queryKey: ['notifications', 'rail'],
    queryFn: () => listNotifications({ limit: 6 }),
  });

  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-5 overflow-y-auto border-border border-l p-4 2xl:flex">
      <div>
        <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Active runs
        </h3>
        {runs.data?.length === 0 && (
          <p className="text-muted-foreground text-sm">factory floor is quiet</p>
        )}
        <div className="space-y-2">
          {runs.data?.map((run) => (
            <Task defaultOpen key={run.id}>
              <TaskTrigger
                title={`${run.pipeline}${run.issueNumber !== null ? ` · #${run.issueNumber}` : ''}`}
              />
              <TaskContent>
                <TaskItem>
                  <span className={`inline-block size-2 rounded-full ${statusDot(run.status)}`} />{' '}
                  {run.status} · step {run.currentStep}
                </TaskItem>
                {run.pendingQuestion && (
                  <TaskItem className="text-amber-600 dark:text-amber-400">
                    ❓ {run.pendingQuestion}
                  </TaskItem>
                )}
                <TaskItem>
                  <Link className="text-primary hover:underline" to={`/runs/${run.id}`}>
                    open run →
                  </Link>
                </TaskItem>
              </TaskContent>
            </Task>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Latest activity
        </h3>
        <div className="space-y-2">
          {notifications.data?.map((n) => (
            <div className="rounded-lg border border-border bg-card p-2.5 text-xs" key={n.id}>
              <p className="line-clamp-2">{n.summary}</p>
              <p className="mt-1 text-muted-foreground">
                {n.event} · {timeAgo(n.created_at)}
                {n.pipeline_run_id && (
                  <>
                    {' · '}
                    <Link className="text-primary hover:underline" to={`/runs/${n.pipeline_run_id}`}>
                      run
                    </Link>
                  </>
                )}
              </p>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

export default function ChatPage(): React.ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const history = useQuery({
    queryKey: ['chat', id],
    queryFn: () => getChatMessages(id!),
    enabled: !!id,
  });

  const [live, setLive] = useState<LiveItem[]>([]);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  const runTurn = async (chatId: string, message: string): Promise<void> => {
    setPendingUser(message);
    setLive([]);
    setStreaming(true);
    try {
      await sendChatMessage(chatId, message, (e: ChatTurnEvent) => {
        if (e.type === 'assistant') setLive((prev) => [...prev, { kind: 'assistant', text: e.text }]);
        else if (e.type === 'tool.use')
          setLive((prev) => [...prev, { kind: 'tool', name: e.name, input: e.input }]);
        else if (e.type === 'error')
          setLive((prev) => [...prev, { kind: 'error', message: e.message }]);
      });
    } catch (err) {
      setLive((prev) => [...prev, { kind: 'error', message: String(err) }]);
    } finally {
      setStreaming(false);
      // refetch history BEFORE clearing the live view — no flash of lost turn
      await queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      setPendingUser(null);
      setLive([]);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      // a turn can dispatch runs / answer questions — refresh the world
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
    }
  };

  const send = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || streaming) return;
    if (id) {
      await runTurn(id, message);
    } else {
      // First message of a fresh conversation: create, navigate, then run.
      const { chatId } = await createChat();
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      navigate(`/chat/${chatId}`, { replace: true, state: { initial: message } });
    }
  };

  // Auto-send the message a fresh "/" conversation was started with.
  const initialSent = useRef(false);
  useEffect(() => {
    const initial = (location.state as { initial?: string } | null)?.initial;
    if (id && initial && !initialSent.current) {
      initialSent.current = true;
      window.history.replaceState({}, '');
      void runTurn(id, initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const historyNodes = useMemo(
    () =>
      history.data?.map((m) => {
        if (m.role === 'user') {
          return (
            <Message from="user" key={m.id}>
              <MessageContent>{m.content}</MessageContent>
            </Message>
          );
        }
        if (m.role === 'assistant') {
          return (
            <Message from="assistant" key={m.id}>
              <MessageContent>
                <MessageResponse>{m.content}</MessageResponse>
              </MessageContent>
            </Message>
          );
        }
        if (m.role === 'tool') {
          try {
            const parsed = JSON.parse(m.content) as { name?: string; input?: unknown };
            return <ToolCard input={parsed.input} key={m.id} name={parsed.name ?? 'tool'} />;
          } catch {
            return null;
          }
        }
        return (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs" key={m.id}>
            {m.content}
          </p>
        );
      }),
    [history.data],
  );

  const isEmpty =
    (history.data?.length ?? 0) === 0 && !pendingUser && live.length === 0 && !streaming;

  const composer = (
    <PromptInput onSubmit={(m: PromptInputMessage) => void send(m.text)}>
      <PromptInputBody>
        <PromptInputTextarea
          disabled={streaming}
          placeholder={streaming ? 'the Master is working…' : 'Message the Master'}
        />
      </PromptInputBody>
      <PromptInputFooter className="justify-end">
        <PromptInputSubmit status={streaming ? 'streaming' : undefined} />
      </PromptInputFooter>
    </PromptInput>
  );

  // Fresh conversation: claude.ai-style centered greeting + composer.
  if (isEmpty) {
    return (
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-2xl">
            <h1 className="font-display mb-2 text-center text-3xl">
              <span className="mr-2">🏭</span>
              What should the factory build?
            </h1>
            <p className="mb-8 text-center text-muted-foreground text-sm">
              The Master re-reads the board, runs, and pipelines every turn — ask for status or
              hand it work.
            </p>
            {composer}
            <Suggestions className="mt-3 justify-center">
              {SUGGESTIONS.map((s) => (
                <Suggestion key={s} onClick={(text) => void send(text)} suggestion={s} />
              ))}
            </Suggestions>
          </div>
        </div>
        <ActivityRail />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl pt-8">
            {historyNodes}
            {pendingUser && (
              <Message from="user">
                <MessageContent>{pendingUser}</MessageContent>
              </Message>
            )}
            {live.map((item, i) =>
              item.kind === 'assistant' ? (
                <Message from="assistant" key={i}>
                  <MessageContent>
                    <MessageResponse>{item.text}</MessageResponse>
                  </MessageContent>
                </Message>
              ) : item.kind === 'tool' ? (
                <ToolCard input={item.input} key={i} name={item.name} />
              ) : (
                <p
                  className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs"
                  key={i}
                >
                  {item.message}
                </p>
              ),
            )}
            {streaming && <Shimmer className="text-sm">Master is working…</Shimmer>}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="mx-auto w-full max-w-3xl px-4 pb-5">
          {composer}
          <p className="mt-2 text-center text-muted-foreground text-xs">
            The Master only acts through factory tools — every action it takes is auditable above.
          </p>
        </div>
      </div>
      <ActivityRail />
    </div>
  );
}
