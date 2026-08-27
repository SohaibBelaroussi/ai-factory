import type { FastifyInstance } from 'fastify';
import { isKnownKey, listSettings, setSetting, KNOWN_KEYS } from '../../modules/settings.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async () => listSettings());

  app.put<{ Params: { key: string }; Body: { value?: string } }>(
    '/settings/:key',
    async (req, reply) => {
      // Accept both the canonical key and the shorthand used in the spec
      // ("claude-token" → "claude-oauth-token").
      const raw = req.params.key === 'claude-token' ? 'claude-oauth-token' : req.params.key;
      if (!isKnownKey(raw)) {
        return reply.code(422).send({
          error: {
            code: 'unknown_setting',
            message: `Unknown setting "${req.params.key}"`,
            details: { known: KNOWN_KEYS },
          },
        });
      }
      const value = req.body?.value;
      if (typeof value !== 'string' || value.trim() === '') {
        return reply.code(422).send({
          error: { code: 'validation', message: 'Body must be {"value": "<non-empty string>"}' },
        });
      }
      await setSetting(raw, value.trim());
      return { key: raw, set: true };
    },
  );
}
