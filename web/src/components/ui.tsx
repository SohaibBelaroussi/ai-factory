import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shared building blocks for the console screens. */

export function PageHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/90 px-8 backdrop-blur">
      <h1 className="font-display min-w-0 truncate text-xl">{title}</h1>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Panel({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={cn('rounded-xl border border-border bg-card', className)}>{children}</div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-blue-600/10 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300',
  validating: 'bg-blue-600/10 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300',
  'in-progress': 'bg-blue-600/10 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300',
  'waiting-human': 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  'needs-review': 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  completed: 'bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  done: 'bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  enabled: 'bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  ready: 'bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  failed: 'bg-red-600/10 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  blocked: 'bg-red-600/10 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  reject: 'bg-red-600/10 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  'not ready': 'bg-red-600/10 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground',
  disabled: 'bg-muted text-muted-foreground',
  pending: 'bg-muted text-muted-foreground',
  backlog: 'bg-muted text-muted-foreground',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  const style = STATUS_STYLE[status] ?? 'bg-muted text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        style,
      )}
    >
      {status}
    </span>
  );
}

export function Spinner(): ReactNode {
  return (
    <span className="inline-block size-4 animate-spin rounded-full border-2 border-border border-t-primary" />
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }): ReactNode {
  return (
    <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
