import { inngest } from './client.js';

/**
 * Phase 0 placeholder so the app syncs with the self-hosted Inngest server.
 * Phase 1 replaces this file's exports with runPipeline.
 */
const ping = inngest.createFunction(
  { id: 'factory-ping' },
  { event: 'factory/ping' },
  async () => ({ ok: true }),
);

export const functions = [ping];
