import { runAuthCheck } from './authCheck.js';
import { runStep } from './step.js';

const mode = process.env.WORKER_MODE ?? 'auth-check';

if (mode === 'auth-check') {
  await runAuthCheck();
} else if (mode === 'step') {
  await runStep();
} else {
  console.error(`Unknown WORKER_MODE "${mode}" (expected "auth-check" or "step")`);
  process.exit(64);
}
