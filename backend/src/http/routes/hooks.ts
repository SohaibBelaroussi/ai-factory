import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  createTrigger,
  listTriggers,
  getTrigger,
  verifySignature,
  fireWebhook,
} from '../../modules/triggers.js';

/**
 * Webhook receiver. Registered in its own encapsulated plugin so the raw body
 * (needed for HMAC) is only retained for /hooks/* requests.
 */
export async function hooksRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      const bad = new Error('webhook body is not valid JSON') as Error & { statusCode: number };
      bad.statusCode = 400;
      done(bad, undefined);
    }
  });

  app.post<{ Params: { triggerId: string } }>('/hooks/:triggerId', async (req, reply) => {
    const trigger = await getTrigger(req.params.triggerId);
    if (!trigger || !trigger.enabled) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such trigger' } });
    }
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature =
      (req.headers['x-hub-signature-256'] as string | undefined) ??
      (req.headers['x-factory-signature'] as string | undefined);
    if (!verifySignature(trigger.hmac_secret, rawBody, signature)) {
      return reply.code(401).send({ error: { code: 'bad_signature', message: 'HMAC verification failed' } });
    }
    const deliveryId =
      (req.headers['x-github-delivery'] as string | undefined) ??
      (req.headers['x-delivery-id'] as string | undefined) ??
      createHash('sha256').update(rawBody).digest('hex').slice(0, 32);

    const result = await fireWebhook(trigger, req.body, deliveryId);
    switch (result.status) {
      case 'spawned':
        return reply.code(201).send({ runId: result.runId });
      case 'duplicate':
        return reply.code(200).send({ runId: result.runId, duplicate: true });
      case 'filtered':
        return reply.code(202).send({ filtered: true });
      case 'refused':
        return reply.code(409).send(result.refusal);
    }
  });
}

/** Trigger management (operator plane — bearer auth applies). */
export async function triggersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/triggers', async () => listTriggers());

  app.post<{
    Body: { name?: string; pipeline?: string; mapping?: Record<string, unknown>; schedule?: string };
  }>('/triggers', async (req, reply) => {
    const { name, pipeline, mapping, schedule } = req.body ?? {};
    if (!name?.trim() || !pipeline?.trim()) {
      return reply.code(422).send({ error: { code: 'validation', message: '{name, pipeline} required' } });
    }
    try {
      const created = await createTrigger({
        name: name.trim(),
        pipeline: pipeline.trim(),
        mapping: mapping as never,
        schedule: schedule ?? null,
      });
      // hmacSecret is shown exactly once — store it in your webhook sender.
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(422).send({ error: { code: 'validation', message: String(err) } });
    }
  });
}
