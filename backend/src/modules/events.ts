import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from '../config.js';

/**
 * Live-update fan-out: a dedicated Postgres connection LISTENs on the
 * factory_events and step_logs channels (fed by DB triggers) and re-emits
 * in-process. SSE routes subscribe here. DB-backed rather than in-process
 * emit so it stays correct if the backend ever runs as multiple instances.
 */

export type FactoryEvent = { channel: 'factory_events' | 'step_logs'; payload: Record<string, unknown> };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function subscribe(fn: (e: FactoryEvent) => void): () => void {
  emitter.on('event', fn);
  return () => emitter.off('event', fn);
}

let started = false;

export function startEventListener(): void {
  if (started) return;
  started = true;
  void connectLoop();
}

async function connectLoop(): Promise<void> {
  for (;;) {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    try {
      await client.connect();
      await client.query('listen factory_events');
      await client.query('listen step_logs');
      client.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          emitter.emit('event', {
            channel: msg.channel as FactoryEvent['channel'],
            payload: JSON.parse(msg.payload) as Record<string, unknown>,
          });
        } catch {
          // malformed payloads are dropped
        }
      });
      await new Promise<void>((resolve) => {
        client.on('error', () => resolve());
        client.on('end', () => resolve());
      });
    } catch {
      // fall through to reconnect
    }
    try {
      await client.end();
    } catch {
      // already gone
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
