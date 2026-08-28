import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listNotifications } from '../lib/api';

/** Unread count lives on the shell; the full center is on /questions. */
export function NotificationBell(): React.ReactNode {
  const { data } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => listNotifications({ unread: true, limit: 200 }),
  });
  const count = data?.length ?? 0;
  return (
    <Link to="/questions" className="relative text-dim hover:text-ink" title="notifications">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-err px-1 text-[10px] font-bold text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
