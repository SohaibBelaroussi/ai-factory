/**
 * Step execution mode — Phase 1.
 * Lifecycle (spec §6.2): clone branch → restore session if resuming →
 * SDK query() with the three prompt layers → stream logs/cost to the internal
 * API → commit/persist → emit exactly one event to Inngest → exit.
 */
export async function runStep(): Promise<never> {
  console.error('step mode is not implemented until Phase 1');
  process.exit(64);
}
