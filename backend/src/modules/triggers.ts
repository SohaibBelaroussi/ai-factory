import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { query } from '../db/client.js';
import { spawnRun, RefusalError } from './commands.js';
import { NotReadyError } from './health.js';

/**
 * Triggers: webhooks (HMAC-signed, payload mapped in code) and cron schedules
 * (evaluated by a once-a-minute Inngest tick). All paths converge on the same
 * spawn command; idempotency comes from delivery/bucket keys, so retries and
 * replays never double-spawn.
 */

export type TriggerRow = {
  id: string;
  name: string;
  pipeline: string;
  mapping: {
    issueNumberPath?: string;
    briefPath?: string;
    briefTemplate?: string;
    brief?: string;
    issueNumber?: number;
    filterPath?: string;
    filterEquals?: string;
  };
  hmac_secret: string;
  schedule: string | null;
  enabled: boolean;
};

export async function createTrigger(args: {
  name: string;
  pipeline: string;
  mapping?: TriggerRow['mapping'];
  schedule?: string | null;
}): Promise<{ id: string; hmacSecret: string; hookUrl: string }> {
  if (args.schedule) CronExpressionParser.parse(args.schedule); // validate early
  const secret = randomBytes(24).toString('hex');
  const res = await query<{ id: string }>(
    `insert into triggers (name, pipeline, mapping, hmac_secret, schedule)
     values ($1, $2, $3, $4, $5) returning id`,
    [args.name, args.pipeline, JSON.stringify(args.mapping ?? {}), secret, args.schedule ?? null],
  );
  const id = res.rows[0]!.id;
  // The secret is returned exactly once, at creation.
  return { id, hmacSecret: secret, hookUrl: `/hooks/${id}` };
}

export async function listTriggers(): Promise<unknown[]> {
  const res = await query<TriggerRow & { created_at: Date }>(
    'select id, name, pipeline, mapping, schedule, enabled, created_at from triggers order by created_at',
  );
  const out = [];
  for (const t of res.rows) {
    const fires = await query(
      `select delivery_id, run_id, outcome, fired_at from trigger_fires
       where trigger_id = $1 order by fired_at desc limit 10`,
      [t.id],
    );
    out.push({ ...t, recentFires: fires.rows });
  }
  return out;
}

export async function getTrigger(id: string): Promise<TriggerRow | null> {
  const res = await query<TriggerRow>('select * from triggers where id = $1', [id]);
  return res.rows[0] ?? null;
}

/** GitHub-style signature: X-Hub-Signature-256: sha256=<hex hmac of raw body>. */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.startsWith('sha256=') ? header.slice(7) : header;
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function renderTemplate(tpl: string, payload: unknown): string {
  return tpl.replace(/\{([\w.]+)\}/g, (_, p: string) => String(pick(payload, p) ?? ''));
}

async function recordFire(
  triggerId: string,
  deliveryId: string,
  runId: string | null,
  outcome: string,
): Promise<boolean> {
  const res = await query(
    `insert into trigger_fires (trigger_id, delivery_id, run_id, outcome)
     values ($1, $2, $3, $4)
     on conflict (trigger_id, delivery_id) where delivery_id is not null do nothing`,
    [triggerId, deliveryId, runId, outcome],
  );
  return (res.rowCount ?? 0) > 0;
}

export type FireResult =
  | { status: 'spawned'; runId: string }
  | { status: 'duplicate'; runId: string | null }
  | { status: 'filtered' }
  | { status: 'refused'; refusal: Record<string, unknown> };

/** Map a validated webhook payload and spawn. Sanitized by construction: only mapped fields enter the brief. */
export async function fireWebhook(
  trigger: TriggerRow,
  payload: unknown,
  deliveryId: string,
): Promise<FireResult> {
  const existing = await query<{ run_id: string | null }>(
    'select run_id from trigger_fires where trigger_id = $1 and delivery_id = $2',
    [trigger.id, deliveryId],
  );
  if (existing.rows[0]) return { status: 'duplicate', runId: existing.rows[0].run_id };

  const m = trigger.mapping;
  if (m.filterPath && String(pick(payload, m.filterPath)) !== String(m.filterEquals)) {
    await recordFire(trigger.id, deliveryId, null, 'filtered');
    return { status: 'filtered' };
  }

  const issueRaw = m.issueNumberPath ? pick(payload, m.issueNumberPath) : m.issueNumber;
  const issueNumber = issueRaw === undefined || issueRaw === null ? null : Number(issueRaw);
  const brief = m.briefTemplate
    ? renderTemplate(m.briefTemplate, payload)
    : m.briefPath
      ? String(pick(payload, m.briefPath) ?? '')
      : (m.brief ?? '');

  try {
    const result = await spawnRun({
      pipeline: trigger.pipeline,
      issueNumber: Number.isFinite(issueNumber as number) ? (issueNumber as number) : null,
      brief,
      createdBy: 'webhook',
      idempotencyKey: `wh-${trigger.id}-${deliveryId}`,
    });
    await recordFire(trigger.id, deliveryId, result.runId, result.existing ? 'duplicate' : 'spawned');
    return result.existing
      ? { status: 'duplicate', runId: result.runId }
      : { status: 'spawned', runId: result.runId };
  } catch (err) {
    if (err instanceof RefusalError) {
      await recordFire(trigger.id, deliveryId, null, `refused:${String(err.refusal.reason)}`);
      return { status: 'refused', refusal: err.refusal };
    }
    if (err instanceof NotReadyError) {
      await recordFire(trigger.id, deliveryId, null, 'refused:not_ready');
      return { status: 'refused', refusal: { reason: 'factory_not_ready' } };
    }
    throw err;
  }
}

/**
 * Called by the once-a-minute Inngest tick. A schedule is due when its cron
 * expression's most recent fire time falls inside the last minute; the minute
 * bucket doubles as the idempotency key, so a retried tick never double-fires.
 */
export async function fireDueSchedules(now: Date): Promise<{ fired: string[] }> {
  const res = await query<TriggerRow>(
    `select * from triggers where enabled and schedule is not null`,
  );
  const fired: string[] = [];
  for (const t of res.rows) {
    let prev: Date;
    try {
      prev = CronExpressionParser.parse(t.schedule!, { currentDate: now }).prev().toDate();
    } catch {
      continue; // invalid expression: skip rather than crash the tick
    }
    if (now.getTime() - prev.getTime() >= 60_000) continue;
    const bucket = `cron-${prev.toISOString()}`;
    const fresh = await recordFire(t.id, bucket, null, 'pending');
    if (!fresh) continue; // this bucket already fired (tick retry / overlap)
    try {
      const result = await spawnRun({
        pipeline: t.pipeline,
        issueNumber: t.mapping.issueNumber ?? null,
        brief: t.mapping.brief ?? `scheduled: ${t.name}`,
        createdBy: 'schedule',
        idempotencyKey: `${t.id}-${bucket}`,
      });
      await query(
        `update trigger_fires set run_id = $3, outcome = 'spawned'
         where trigger_id = $1 and delivery_id = $2`,
        [t.id, bucket, result.runId],
      );
      fired.push(t.name);
    } catch (err) {
      const outcome =
        err instanceof RefusalError
          ? `refused:${String(err.refusal.reason)}`
          : err instanceof NotReadyError
            ? 'refused:not_ready'
            : 'error';
      await query(
        `update trigger_fires set outcome = $3 where trigger_id = $1 and delivery_id = $2`,
        [t.id, bucket, outcome],
      );
    }
  }
  return { fired };
}
