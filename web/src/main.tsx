import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { EventBusProvider } from './lib/events';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Freshness is driven by /events invalidation, not polling.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <EventBusProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </EventBusProvider>
    </QueryClientProvider>
  </StrictMode>,
);
