import { getSetting } from './settings.js';

/**
 * GitHub adapter. GitHub stays authoritative for issues, code, branches, PRs;
 * everything here is either a read or a narrowly-scoped write (branch create,
 * pipeline/ file put). Uses the REST API only — the backend never clones.
 */

const API = 'https://api.github.com';

async function creds(): Promise<{ token: string; repo: string }> {
  const [token, repo] = await Promise.all([getSetting('github-token'), getSetting('github-repo')]);
  if (!token) throw new Error('github-token setting is not set');
  if (!repo) throw new Error('github-repo setting is not set');
  return { token, repo };
}

async function gh(
  path: string,
  init: RequestInit & { allow404?: boolean } = {},
): Promise<Response> {
  const { token } = await creds();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ai-factory',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok && !(init.allow404 && res.status === 404)) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

export async function getRepoFullName(): Promise<string> {
  return (await creds()).repo;
}

export async function getDefaultBranch(): Promise<string> {
  const { repo } = await creds();
  const res = await gh(`/repos/${repo}`);
  return ((await res.json()) as { default_branch: string }).default_branch;
}

/** Create the run branch from the default branch head; reuse it if it exists. */
export async function ensureBranch(branch: string): Promise<void> {
  const { repo } = await creds();
  const existing = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { allow404: true });
  if (existing.status !== 404) return;
  const def = await getDefaultBranch();
  const head = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(def)}`);
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  await gh(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
}

/** Create or overwrite a file on a branch (used for pipeline/brief.md). */
export async function putFile(
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const { repo } = await creds();
  const apiPath = `/repos/${repo}/contents/${path}`;
  const existing = await gh(`${apiPath}?ref=${encodeURIComponent(branch)}`, { allow404: true });
  const sha =
    existing.status === 404 ? undefined : ((await existing.json()) as { sha?: string }).sha;
  await gh(apiPath, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      branch,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
}

export async function fileExists(branch: string, path: string): Promise<boolean> {
  const { repo } = await creds();
  const res = await gh(
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { allow404: true },
  );
  if (res.status !== 404) await res.body?.cancel();
  return res.status !== 404;
}

export async function readFile(branch: string, path: string): Promise<string | null> {
  const { repo } = await creds();
  const res = await gh(
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { allow404: true },
  );
  if (res.status === 404) return null;
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (!json.content) return null;
  return Buffer.from(json.content, 'base64').toString('utf8');
}

/** Names of files under pipeline/ on the branch (for layer-3 "artifacts available"). */
export async function listPipelineArtifacts(branch: string): Promise<string[]> {
  const { repo } = await creds();
  const res = await gh(
    `/repos/${repo}/contents/pipeline?ref=${encodeURIComponent(branch)}`,
    { allow404: true },
  );
  if (res.status === 404) return [];
  const entries = (await res.json()) as { name: string; type: string }[];
  return entries.filter((e) => e.type === 'file').map((e) => e.name);
}

export type IssueSummary = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
};

/** All issues (open + closed), PRs filtered out. Paginates up to 300 issues. */
export async function listIssues(): Promise<IssueSummary[]> {
  const { repo } = await creds();
  const out: IssueSummary[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await gh(`/repos/${repo}/issues?state=all&per_page=100&page=${page}`);
    const batch = (await res.json()) as ({
      number: number;
      title: string;
      body: string | null;
      state: string;
      labels: ({ name?: string } | string)[];
      pull_request?: unknown;
    })[];
    for (const i of batch) {
      if (i.pull_request) continue;
      out.push({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        state: i.state,
        labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

export async function getIssueComments(n: number, limit = 20): Promise<{ author: string; body: string }[]> {
  const { repo } = await creds();
  const res = await gh(`/repos/${repo}/issues/${n}/comments?per_page=${limit}`);
  const json = (await res.json()) as { user?: { login?: string }; body?: string }[];
  return json.map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body ?? '' }));
}

export async function addIssueComment(n: number, body: string): Promise<void> {
  const { repo } = await creds();
  await gh(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

export async function setIssueLabels(n: number, labels: string[]): Promise<void> {
  const { repo } = await creds();
  await gh(`/repos/${repo}/issues/${n}/labels`, { method: 'PUT', body: JSON.stringify({ labels }) });
}

export async function getIssue(
  n: number,
): Promise<{ number: number; title: string; body: string; labels: string[]; state: string } | null> {
  const { repo } = await creds();
  const res = await gh(`/repos/${repo}/issues/${n}`, { allow404: true });
  if (res.status === 404) return null;
  const json = (await res.json()) as {
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: ({ name?: string } | string)[];
  };
  return {
    number: json.number,
    title: json.title,
    body: json.body ?? '',
    state: json.state,
    labels: json.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
  };
}
