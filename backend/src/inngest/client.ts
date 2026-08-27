import { Inngest } from 'inngest';
import { config } from '../config.js';

/**
 * Event catalog (the runner's entire vocabulary):
 *   pipeline.run.requested · step.finished · step.waiting_human ·
 *   question.answered · pipeline.run.completed · pipeline.run.failed
 * Workers emit step.* directly to the Inngest server on the factory network.
 */
export const inngest = new Inngest({
  id: 'ai-factory',
  eventKey: config.inngestEventKey,
  baseUrl: config.inngestBaseUrl,
  isDev: false,
});
