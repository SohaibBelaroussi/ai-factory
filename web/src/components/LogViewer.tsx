import { useEffect, useRef, useState } from 'react';
import { API_BASE, authHeaders } from '../lib/api';
import { persistentSse } from '../lib/sse';
import type { LogRow } from '../lib/types';

/**
 * Live tail of a run's step_logs over /runs/:id/logs/stream. The cursor
 * survives reconnects (?after=), so a dropped connection resumes cleanly.
 * Events are raw SDK message envelopes plus {type:'worker'} notes.
 */

type Rendered = { key: string; stepIndex: number; attempt: number; node: React.ReactNode };

const MAX_ROWS = 1500;

function previewInput(input: unknown): string {
  const s = JSON.stringify(input) ?? '';
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}

function renderEvent(row: LogRow): React.ReactNode | null {
  const e = row.event as Record<string, any>;
  if (!e || typeof e !== 'object') return null;

  switch (e.type) {
    case 'worker':
      return <div className="text-warn/80 italic">◈ {String(e.text ?? '')}</div>;
    case 'system':
      if (e.subtype === 'init' || e.model)
        return (
          <div className="text-faint">
            ▸ session init · model {String(e.model ?? '?')} · cwd {String(e.cwd ?? '?')}
          </div>
        );
      return null;
    case 'assistant': {
      const content = e.message?.content;
      if (!Array.isArray(content)) return null;
      const parts: React.ReactNode[] = [];
      content.forEach((c: Record<string, any>, i: number) => {
        if (c.type === 'text' && c.text?.trim()) {
          parts.push(
            <div key={i} className="whitespace-pre-wrap text-ink">
              {c.text}
            </div>,
          );
        } else if (c.type === 'tool_use') {
          parts.push(
            <div key={i} className="text-accent">
              ⚙ {String(c.name)}{' '}
              <span className="text-faint">{previewInput(c.input)}</span>
            </div>,
          );
        }
        // thinking blocks are omitted
      });
      return parts.length > 0 ? <>{parts}</> : null;
    }
    case 'user': {
      const content = e.message?.content;
      if (!Array.isArray(content)) return null;
      const results = content.filter((c: Record<string, any>) => c.type === 'tool_result');
      if (results.length === 0) return null;
      const text = results
        .map((r: Record<string, any>) =>
          typeof r.content === 'string'
            ? r.content
            : Array.isArray(r.content)
              ? r.content.map((p: Record<string, any>) => p.text ?? '').join('')
              : '',
        )
        .join('\n');
      const trimmed = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      return trimmed.trim() ? (
        <div className="whitespace-pre-wrap text-faint">↳ {trimmed}</div>
      ) : null;
    }
    case 'result':
      return (
        <div className="text-ok">
          ■ result · {String(e.subtype ?? '')} · $
          {Number(e.total_cost_usd ?? 0).toFixed(4)}
        </div>
      );
    default:
      return null; // rate_limit_event, tool_progress, …
  }
}

export function LogViewer({ runId }: { runId: string }): React.ReactNode {
  const [rows, setRows] = useState<Rendered[]>([]);
  const cursorRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // autoscroll unless the user scrolled up

  useEffect(() => {
    setRows([]);
    cursorRef.current = 0;
    const stop = persistentSse(
      () => `${API_BASE}/runs/${runId}/logs/stream?after=${cursorRef.current}`,
      {
        headers: authHeaders,
        onMessage: (msg) => {
          if (msg.event !== 'log') return;
          let row: LogRow;
          try {
            row = JSON.parse(msg.data) as LogRow;
          } catch {
            return;
          }
          cursorRef.current = Math.max(cursorRef.current, Number(row.id));
          const node = renderEvent(row);
          if (!node) return;
          setRows((prev) => {
            const next = [
              ...prev,
              { key: String(row.id), stepIndex: row.step_index, attempt: row.attempt, node },
            ];
            return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
          });
        },
      },
    );
    return stop;
  }, [runId]);

  useEffect(() => {
    if (pinnedRef.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [rows]);

  return (
    <div
      ref={boxRef}
      onScroll={() => {
        const el = boxRef.current;
        if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className="h-[480px] overflow-y-auto rounded-md bg-black/40 p-3 font-mono text-xs leading-relaxed"
    >
      {rows.length === 0 && <div className="text-faint">no log events yet…</div>}
      {rows.map((row, i) => {
        const prev = rows[i - 1];
        const boundary = !prev || prev.stepIndex !== row.stepIndex || prev.attempt !== row.attempt;
        return (
          <div key={row.key}>
            {boundary && (
              <div className="mt-2 mb-1 border-b border-border pb-0.5 font-semibold text-dim">
                — step {row.stepIndex + 1} · attempt {row.attempt} —
              </div>
            )}
            {row.node}
          </div>
        );
      })}
    </div>
  );
}
