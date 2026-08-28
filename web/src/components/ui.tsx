import type { ReactNode } from 'react';

/** Small shared building blocks — kept deliberately boring. */

export function PageHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-bg/90 px-6 backdrop-blur">
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
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
    <div className={`rounded-lg border border-border bg-panel ${className}`}>{children}</div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  // run + step statuses
  running: 'bg-accent/15 text-accent',
  validating: 'bg-accent/15 text-accent',
  'waiting-human': 'bg-warn/15 text-warn',
  completed: 'bg-ok/15 text-ok',
  done: 'bg-ok/15 text-ok',
  failed: 'bg-err/15 text-err',
  cancelled: 'bg-faint/20 text-dim',
  pending: 'bg-faint/20 text-dim',
  // board statuses
  backlog: 'bg-faint/20 text-dim',
  'in-progress': 'bg-accent/15 text-accent',
  'needs-review': 'bg-warn/15 text-warn',
  blocked: 'bg-err/15 text-err',
  // verdicts
  reject: 'bg-err/15 text-err',
  // pipelines
  enabled: 'bg-ok/15 text-ok',
  disabled: 'bg-faint/20 text-dim',
  // health
  ready: 'bg-ok/15 text-ok',
  'not ready': 'bg-err/15 text-err',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  const style = STATUS_STYLE[status] ?? 'bg-faint/20 text-dim';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${style}`}
    >
      {status}
    </span>
  );
}

export function Spinner(): ReactNode {
  return (
    <span className="inline-block size-4 animate-spin rounded-full border-2 border-border border-t-accent" />
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="p-8 text-center text-sm text-dim">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }): ReactNode {
  return (
    <div className="m-4 rounded-md border border-err/30 bg-err/10 p-3 text-sm text-err">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
