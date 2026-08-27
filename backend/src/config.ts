function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),

  inngestBaseUrl: process.env.INNGEST_BASE_URL ?? 'http://inngest:8288',
  inngestEventKey: process.env.INNGEST_EVENT_KEY ?? 'local-dev-event-key',
  inngestSigningKey: process.env.INNGEST_SIGNING_KEY ?? '',

  // Empty = public plane unauthenticated (local dev only).
  operatorToken: process.env.OPERATOR_TOKEN ?? '',

  sessionStoreDir: process.env.SESSION_STORE_DIR ?? '/data/sessions',
  workerImage: process.env.WORKER_IMAGE ?? 'ai-factory-worker:latest',
  dockerNetwork: process.env.DOCKER_NETWORK ?? 'factory',
  dockerSocket: process.env.DOCKER_SOCK ?? '/var/run/docker.sock',
  // How workers reach the internal plane, from inside the factory network.
  internalApiUrl: process.env.INTERNAL_API_URL ?? 'http://backend:3000',

  migrationsDir: process.env.MIGRATIONS_DIR ?? new URL('../migrations', import.meta.url).pathname,
} as const;
