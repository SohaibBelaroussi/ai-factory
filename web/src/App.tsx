import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useBusStatus } from './lib/events';
import BoardPage from './pages/BoardPage';
import RunsPage from './pages/RunsPage';
import RunDetailPage from './pages/RunDetailPage';
import ChatPage from './pages/ChatPage';
import PipelinesPage from './pages/PipelinesPage';
import PipelineEditorPage from './pages/PipelineEditorPage';
import QuestionsPage from './pages/QuestionsPage';
import SettingsPage from './pages/SettingsPage';
import { NotificationBell } from './components/NotificationBell';

const NAV = [
  { to: '/board', label: 'Board' },
  { to: '/runs', label: 'Runs' },
  { to: '/chat', label: 'Chat' },
  { to: '/pipelines', label: 'Pipelines' },
  { to: '/questions', label: 'Questions' },
  { to: '/settings', label: 'Settings' },
];

function BusDot(): React.ReactNode {
  const status = useBusStatus();
  const color =
    status === 'open' ? 'bg-ok' : status === 'connecting' ? 'bg-warn' : 'bg-err';
  const label = status === 'open' ? 'live' : status === 'connecting' ? 'connecting' : 'offline';
  return (
    <span className="flex items-center gap-1.5 text-xs text-dim" title={`event stream: ${label}`}>
      <span className={`inline-block size-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export default function App(): React.ReactNode {
  return (
    <div className="flex h-full">
      <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-panel">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <span className="text-lg">🏭</span>
          <span className="font-semibold tracking-tight">AI Factory</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-panel-2 font-medium text-ink'
                    : 'text-dim hover:bg-panel-2 hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-3">
          <BusDot />
          <NotificationBell />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/board" replace />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/pipelines" element={<PipelinesPage />} />
          <Route path="/pipelines/new" element={<PipelineEditorPage />} />
          <Route path="/pipelines/:id" element={<PipelineEditorPage />} />
          <Route path="/questions" element={<QuestionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
