import { config } from './config.js';
import { waitForDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './http/server.js';
import { seedPipelines } from './modules/pipelines.js';
import { startEventListener } from './modules/events.js';

async function main(): Promise<void> {
  await waitForDb();
  const applied = await migrate();
  if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);
  await seedPipelines();
  startEventListener();

  const app = buildServer();
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`ai-factory backend listening on :${config.port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
