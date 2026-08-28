import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { createChat, getChatMessages, listChats, sendChatMessage } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { ChatTurnEvent } from '../lib/types';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';

/**
 * Master chat: history from the DB mirror, live turns over the SSE POST
 * stream. The Master only acts through its factory tools — tool calls render
 * as chips in the thread.
 */

type LiveItem =
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'error'; message: string };

function ToolChip({ name, input }: { name: string; input: unknown }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const preview = JSON.stringify(input) ?? '';
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-left font-mono text-xs text-accent hover:bg-accent/20"
      >
        ⚙ {name.replace(/^mcp__factory__/, '')}{' '}
        {!open && <span className="text-accent/60">{preview.length > 80 ? `${preview.slice(0, 80)}…` : preview}</span>}
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto rounded-md bg-black/40 p-2 font-mono text-xs text-dim">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Bubble({ role, content }: { role: string; content: string }): React.ReactNode {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-accent-dim/40 px-3 py-2 text-sm whitespace-pre-wrap">
          {content}
        </div>
      </div>
    );
  }
  if (role === 'tool') {
    let parsed: { name?: string; input?: unknown } = {};
    try {
      parsed = JSON.parse(content) as { name?: string; input?: unknown };
    } catch {
      return <div className="font-mono text-xs text-dim">{content}</div>;
    }
    return <ToolChip name={parsed.name ?? 'tool'} input={parsed.input} />;
  }
  if (role === 'system') {
    return <div className="rounded-md bg-err/10 px-3 py-2 text-xs text-err">{content}</div>;
  }
  return (
    <div className="max-w-[90%] rounded-lg bg-panel-2 px-3 py-2 text-sm whitespace-pre-wrap">
      {content}
    </div>
  );
}

function Thread({ chatId }: { chatId: string }): React.ReactNode {
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => getChatMessages(chatId),
  });
  const [live, setLive] = useState<LiveItem[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [history.data, live, pendingUser]);

  const send = async (): Promise<void> => {
    const message = input.trim();
    if (!message || streaming) return;
    setInput('');
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={boxRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {history.isLoading && <Spinner />}
        {history.isError && <ErrorNote error={history.error} />}
        {history.data?.length === 0 && !pendingUser && (
          <Empty>
            Ask the Master anything — status, dispatching runs, answering questions. It re-reads the
            factory state every turn.
          </Empty>
        )}
        {history.data?.map((m) => (
          <Bubble key={m.id} role={m.role} content={m.content} />
        ))}
        {pendingUser && <Bubble role="user" content={pendingUser} />}
        {live.map((item, i) =>
          item.kind === 'assistant' ? (
            <Bubble key={i} role="assistant" content={item.text} />
          ) : item.kind === 'tool' ? (
            <ToolChip key={i} name={item.name} input={item.input} />
          ) : (
            <Bubble key={i} role="system" content={item.message} />
          ),
        )}
        {streaming && (
          <div className="flex items-center gap-2 text-xs text-dim">
            <Spinner /> Master is working…
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={streaming ? 'waiting for the Master…' : 'message the Master (Enter to send)'}
            disabled={streaming}
            className="min-w-0 flex-1 resize-none rounded-md border border-border bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            onClick={() => void send()}
            disabled={!input.trim() || streaming}
            className="self-end rounded-md bg-accent-dim px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-40"
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage(): React.ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const chats = useQuery({ queryKey: ['chats'], queryFn: listChats });
  const newChat = useMutation({
    mutationFn: createChat,
    onSuccess: (res) => navigate(`/chat/${res.chatId}`),
  });

  // No chat selected: jump to the most recent, or show the empty state.
  useEffect(() => {
    if (!id && chats.data && chats.data.length > 0) {
      navigate(`/chat/${chats.data[0]!.id}`, { replace: true });
    }
  }, [id, chats.data, navigate]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Master Chat">
        <button
          onClick={() => newChat.mutate()}
          disabled={newChat.isPending}
          className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-40"
        >
          + new chat
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-border">
          {chats.data?.map((c) => (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              className={`block border-b border-border/50 px-3 py-2.5 text-sm hover:bg-panel ${
                c.id === id ? 'bg-panel font-medium' : 'text-dim'
              }`}
            >
              <div className="truncate">{c.title ?? 'untitled chat'}</div>
              <div className="text-xs text-faint">{timeAgo(c.last_message_at)}</div>
            </Link>
          ))}
          {chats.data?.length === 0 && (
            <div className="p-3 text-xs text-dim">no chats yet</div>
          )}
        </aside>

        {id ? (
          <Thread key={id} chatId={id} />
        ) : (
          <Empty>create a chat to talk to the Master</Empty>
        )}
      </div>
    </div>
  );
}
