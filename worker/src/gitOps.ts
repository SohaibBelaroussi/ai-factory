import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const WORK = '/work';

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: WORK, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Clone the run branch into the canonical cwd /work (must be empty). */
export async function cloneBranch(repo: string, branch: string, token: string): Promise<string> {
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  await git('clone', '--branch', branch, url, '.');
  await git('config', 'user.email', 'factory-worker@ai-factory.local');
  await git('config', 'user.name', 'AI Factory Worker');
  return git('rev-parse', 'HEAD');
}

/** Safety-net persist: commit anything the agent left uncommitted, then push. */
export async function persistAndPush(branch: string, message: string): Promise<void> {
  const status = await git('status', '--porcelain');
  if (status !== '') {
    await git('add', '-A');
    await git('commit', '-m', message);
  }
  await git('push', 'origin', `HEAD:${branch}`);
}

/** Commits created during this step (oldest first). */
export async function commitsSince(baseSha: string): Promise<string[]> {
  const out = await git('rev-list', '--reverse', `${baseSha}..HEAD`);
  return out === '' ? [] : out.split('\n');
}
