import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeftIcon, PlusIcon, RadioIcon } from 'lucide-react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createChat,
  getChatMessages,
  listChats,
  listNotifications,
  listRuns,
  sendChatMessage,
} from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useBusStatus } from '@/lib/events';
import type { ChatTurnEvent } from '@/lib/types';

/**
 * v2 prototype — the Master chat rebuilt on AI SDK Elements (shadcn).
 * Same backend, same mirror, same SSE turn stream as v1; only the surface
 * changed: markdown answers, collapsible tool cards, stick-to-bottom
 * conversation, a real composer, and an ambient activity rail.
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
        type="dynamic-tool"
        toolName={name.replace(/^mcp__factory__/, '')}
        state="output-available"
      />
      <ToolContent>
        <ToolInput input={input} />
      </ToolContent>
    </Tool>
  );
}

function statusDot(status: string): string {
  if (status === 'running') return 'bg-blue-400';
  if (status === 'waiting-human') return 'bg-amber-400';
  if (status === 'completed') return 'bg-emerald-400';
  if (status === 'failed') return 'bg-red-400';
  return 'bg-neutral-500';
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
    <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-border border-l p-4 xl:flex">
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
                  <TaskItem className="text-amber-400">❓ {run.pendingQuestion}</TaskItem>
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
            <div className="rounded-md border border-border p-2 text-xs" key={n.id}>
              <p className="line-clamp-2 text-foreground">{n.summary}</p>
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

export default function ChatV2Page(): React.ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const busStatus = useBusStatus();

  const chats = useQuery({ queryKey: ['chats'], queryFn: listChats });
  const chatId = id ?? chats.data?.[0]?.id;
  const history = useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => getChatMessages(chatId!),
    enabled: !!chatId,
  });

  const [live, setLive] = useState<LiveItem[]>([]);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  const newChat = useMutation({
    mutationFn: createChat,
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      navigate(`/v2/chat/${res.chatId}`);
    },
  });

  const send = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || streaming || !chatId) return;
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
      await queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      setPendingUser(null);
      setLive([]);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['board'] });
    }
  };

  const handleSubmit = (message: PromptInputMessage): void => {
    void send(message.text);
  };

  const isEmpty =
    (history.data?.length ?? 0) === 0 && !pendingUser && live.length === 0 && !streaming;

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
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs" key={m.id}>
            {m.content}
          </p>
        );
      }),
    [history.data],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
        <Button asChild size="icon-sm" variant="ghost">
          <Link title="back to v1" to="/board">
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <span className="font-semibold">🏭 Master Chat</span>
        <Badge className="gap-1.5" variant="secondary">
          v2 preview
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Badge className="gap-1.5" variant="outline">
            <RadioIcon
              className={`size-3 ${busStatus === 'open' ? 'text-emerald-400' : 'text-amber-400'}`}
            />
            {busStatus === 'open' ? 'live' : busStatus}
          </Badge>
          <Select
            onValueChange={(value) => navigate(`/v2/chat/${value}`)}
            value={chatId ?? undefined}
          >
            <SelectTrigger className="w-56" size="sm">
              <SelectValue placeholder="choose a chat" />
            </SelectTrigger>
            <SelectContent>
              {chats.data?.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title ?? `chat · ${timeAgo(c.last_message_at)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={newChat.isPending}
            onClick={() => newChat.mutate()}
            size="sm"
            variant="secondary"
          >
            <PlusIcon className="size-4" /> new chat
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Conversation className="min-h-0 flex-1">
            <ConversationContent className="mx-auto w-full max-w-3xl">
              {isEmpty ? (
                <ConversationEmptyState
                  description="Ask about status, dispatch pipelines, answer pending questions — the Master re-reads the factory every turn."
                  icon={<span className="text-3xl">🏭</span>}
                  title="Talk to the Master"
                />
              ) : (
                <>
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
                        className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs"
                        key={i}
                      >
                        {item.message}
                      </p>
                    ),
                  )}
                  {streaming && <Shimmer className="text-sm">Master is working…</Shimmer>}
                </>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            <Suggestions className="mb-2">
              {SUGGESTIONS.map((s) => (
                <Suggestion key={s} onClick={(text) => void send(text)} suggestion={s} />
              ))}
            </Suggestions>
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  disabled={streaming || !chatId}
                  placeholder={streaming ? 'the Master is working…' : 'message the Master'}
                />
              </PromptInputBody>
              <PromptInputFooter className="justify-end">
                <PromptInputSubmit status={streaming ? 'streaming' : undefined} />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>

        <ActivityRail />
      </div>
    </div>
  );
}
