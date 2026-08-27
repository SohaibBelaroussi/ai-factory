import http from 'node:http';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { getSetting } from './settings.js';

export type Check = { ok: boolean; detail: string };
export type Health = { ready: boolean; checks: Record<string, Check> };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

async function checkPostgres(): Promise<Check> {
  try {
    await withTimeout(query('select 1'), 2000, 'postgres query');
    return { ok: true, detail: 'connected' };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function checkInngest(): Promise<Check> {
  for (const path of ['/health', '/']) {
    try {
      const res = await withTimeout(
        fetch(`${config.inngestBaseUrl}${path}`, { method: 'GET' }),
        2500,
        'inngest fetch',
      );
      if (res.ok) return { ok: true, detail: `reachable at ${config.inngestBaseUrl}${path}` };
    } catch {
      // try next path / fall through
    }
  }
  return { ok: false, detail: `not reachable at ${config.inngestBaseUrl}` };
}

async function checkClaudeToken(): Promise<Check> {
  const token = await getSetting('claude-oauth-token');
  if (!token) return { ok: false, detail: 'missing — PUT /settings/claude-token' };
  // Presence-only: real validation is the worker AUTH_OK test (subscription
  // auth can only be exercised from inside a worker session).
  return { ok: true, detail: 'set (validate with the worker auth test)' };
}

async function checkGithubToken(): Promise<Check> {
  const token = await getSetting('github-token');
  if (!token) return { ok: false, detail: 'missing — PUT /settings/github-token' };
  try {
    const res = await withTimeout(
      fetch('https://api.github.com/rate_limit', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ai-factory',
        },
      }),
      4000,
      'github fetch',
    );
    if (res.status === 200) return { ok: true, detail: 'token valid' };
    return { ok: false, detail: `GitHub rejected the token (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, detail: `could not validate against GitHub: ${String(err)}` };
  }
}

async function checkGithubRepo(): Promise<Check> {
  const repo = await getSetting('github-repo');
  if (!repo) return { ok: false, detail: 'missing — PUT /settings/github-repo (owner/name)' };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, detail: `"${repo}" is not owner/name format` };
  }
  return { ok: true, detail: repo };
}

/** Ping the Docker daemon over the mounted socket (provisioner dependency). */
async function checkDocker(): Promise<Check> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: config.dockerSocket, path: '/_ping', method: 'GET', timeout: 2000 },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve({ ok: true, detail: `daemon reachable via ${config.dockerSocket}` });
        else resolve({ ok: false, detail: `daemon ping returned HTTP ${res.statusCode}` });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: 'daemon ping timed out' });
    });
    req.on('error', (err) => resolve({ ok: false, detail: `socket ${config.dockerSocket}: ${err.message}` }));
    req.end();
  });
}

export async function checkHealth(): Promise<Health> {
  const [postgres, inngest, claudeToken, githubToken, githubRepo, docker] = await Promise.all([
    checkPostgres(),
    checkInngest(),
    checkClaudeToken(),
    checkGithubToken(),
    checkGithubRepo(),
    checkDocker(),
  ]);
  const checks = { postgres, inngest, claudeToken, githubToken, githubRepo, docker };
  return { ready: Object.values(checks).every((c) => c.ok), checks };
}

export class NotReadyError extends Error {
  constructor(public readonly health: Health) {
    super('Factory is not ready to dispatch');
  }
}

/** Called by every dispatch command: refuses until all health checks are green. */
export async function assertReady(): Promise<void> {
  const health = await checkHealth();
  if (!health.ready) throw new NotReadyError(health);
}
