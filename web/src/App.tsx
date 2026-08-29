import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  BellIcon,
  KanbanSquareIcon,
  ListTreeIcon,
  MessageSquareIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  WorkflowIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { createChat, listChats, listNotifications } from './lib/api';
import { useBusStatus } from './lib/events';
import { getTheme, setTheme } from './lib/theme';
import { timeAgo } from './lib/format';
import { cn } from '@/lib/utils';
import BoardPage from './pages/BoardPage';
import RunsPage from './pages/RunsPage';
import RunDetailPage from './pages/RunDetailPage';
import IssueDetailPage from './pages/IssueDetailPage';
import PipelinesPage from './pages/PipelinesPage';
import PipelineEditorPage from './pages/PipelineEditorPage';
import QuestionsPage from './pages/QuestionsPage';
import SettingsPage from './pages/SettingsPage';

// Chat pulls in the AI Elements stack (streamdown/shiki) — code-split it.
const ChatPage = lazy(() => import('./pages/ChatPage'));

const NAV = [
  { to: '/', label: 'Chat', icon: MessageSquareIcon, end: true },
  { to: '/board', label: 'Board', icon: KanbanSquareIcon },
  { to: '/runs', label: 'Runs', icon: ListTreeIcon },
  { to: '/pipelines', label: 'Pipelines', icon: WorkflowIcon },
  { to: '/questions', label: 'Inbox', icon: BellIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function BusDot(): React.ReactNode {
  const status = useBusStatus();
  const color =
    status === 'open' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-red-500';
  const label = status === 'open' ? 'live' : status;
  return (
    <span
      className="flex items-center gap-1.5 text-muted-foreground text-xs"
      title={`event stream: ${label}`}
    >
      <span className={cn('inline-block size-2 rounded-full', color)} />
      {label}
    </span>
  );
}

function ThemeToggle(): React.ReactNode {
  const [theme, set] = useState(getTheme());
  return (
    <Button
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        set(next);
      }}
      size="icon-sm"
      title={theme === 'dark' ? 'switch to light' : 'switch to dark'}
      variant="ghost"
    >
      {theme === 'dark' ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </Button>
  );
}

function UnreadBadge(): React.ReactNode {
  const { data } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => listNotifications({ unread: true, limit: 200 }),
  });
  const count = data?.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-semibold text-[10px] text-primary-foreground">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function Sidebar(): React.ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const chats = useQuery({ queryKey: ['chats'], queryFn: listChats });
  const newChat = useMutation({
    mutationFn: createChat,
    onSuccess: (res) => navigate(`/chat/${res.chatId}`),
  });
  const onChat = location.pathname === '/' || location.pathname.startsWith('/chat/');

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="text-xl">🏭</span>
        <span className="font-display text-lg">AI Factory</span>
      </div>

      <div className="px-3">
        <Button
          className="w-full justify-start gap-2 rounded-xl"
          disabled={newChat.isPending}
          onClick={() => newChat.mutate()}
        >
          <PlusIcon className="size-4" /> New chat
        </Button>
      </div>

      <nav className="mt-3 flex flex-col gap-0.5 px-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                isActive || (item.end && onChat && item.to === '/')
                  ? 'bg-background font-medium text-foreground shadow-sm dark:bg-secondary'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground dark:hover:bg-secondary/60',
              )
            }
          >
            <item.icon className="size-4" />
            {item.label}
            {item.to === '/questions' && <UnreadBadge />}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <p className="px-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Recents
        </p>
        {chats.isLoading && (
          <div className="space-y-2 px-3 py-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
          </div>
        )}
        {chats.data?.slice(0, 12).map((c) => (
          <NavLink
            key={c.id}
            to={`/chat/${c.id}`}
            className={({ isActive }) =>
              cn(
                'block truncate rounded-lg px-3 py-1.5 text-sm',
                isActive
                  ? 'bg-background font-medium text-foreground dark:bg-secondary'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground dark:hover:bg-secondary/60',
              )
            }
            title={c.title ?? undefined}
          >
            {c.title ?? `chat · ${timeAgo(c.last_message_at)}`}
          </NavLink>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-sidebar-border px-4 py-3">
        <BusDot />
        <ThemeToggle />
      </div>
    </aside>
  );
}

export default function App(): React.ReactNode {
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Suspense
          fallback={<div className="p-8 text-muted-foreground text-sm">loading…</div>}
        >
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="/chat" element={<Navigate to="/" replace />} />
            <Route path="/v2" element={<Navigate to="/" replace />} />
            <Route path="/v2/chat/:id" element={<Navigate to="/" replace />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/issues/:n" element={<IssueDetailPage />} />
            <Route path="/pipelines" element={<PipelinesPage />} />
            <Route path="/pipelines/new" element={<PipelineEditorPage />} />
            <Route path="/pipelines/:id" element={<PipelineEditorPage />} />
            <Route path="/questions" element={<QuestionsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
