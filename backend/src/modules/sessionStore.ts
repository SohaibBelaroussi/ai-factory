import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Step-suspension session store paths. The store holds only OPEN suspensions
 * (and Master chats, elsewhere) — a step's stored session is deleted when the
 * step reaches a terminal state.
 */
export function stepSessionPath(stepRunId: string): string {
  return join(config.sessionStoreDir, 'steps', `${stepRunId}.json`);
}

export async function deleteStepSession(stepRunId: string): Promise<void> {
  try {
    await unlink(stepSessionPath(stepRunId));
  } catch {
    // no stored session — the common case
  }
}
