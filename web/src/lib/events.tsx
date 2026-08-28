import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, authHeaders } from './api';
import { persistentSse } from './sse';

/**
 * The app-wide live-update bus. /events sends ids only — clients re-fetch.
 * That maps 1:1 onto query invalidation: an event names the queries it makes
 * stale, TanStack Query re-fires whichever of them are on screen.
 */

export type BusStatus = 'connecting' | 'open' | 'down';

const BusContext = createContext<BusStatus>('connecting');

export function EventBusProvider({ children }: { children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BusStatus>('connecting');

  useEffect(() => {
    const stop = persistentSse(() => `${API_BASE}/events`, {
      headers: authHeaders,
      onStatus: setStatus,
      onMessage: (msg) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const invalidate = (key: readonly unknown[]): void => {
          void queryClient.invalidateQueries({ queryKey: key });
        };
        switch (msg.event) {
          case 'run.updated':
            invalidate(['runs']);
            if (typeof payload.id === 'string') invalidate(['run', payload.id]);
            break;
          case 'question.created':
            invalidate(['questions']);
            invalidate(['runs']);
            invalidate(['run']); // any open run-detail view shows the new question
            break;
          case 'notification.created':
            invalidate(['notifications']);
            break;
          case 'board.updated':
            invalidate(['board']);
            if (typeof payload.number === 'number') invalidate(['issue', payload.number]);
            break;
          case 'hello':
            break;
          default:
            break;
        }
      },
    });
    return stop;
  }, [queryClient]);

  return <BusContext.Provider value={status}>{children}</BusContext.Provider>;
}

export function useBusStatus(): BusStatus {
  return useContext(BusContext);
}
