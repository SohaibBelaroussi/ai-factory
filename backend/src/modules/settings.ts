import { query } from '../db/client.js';

/**
 * Known setting keys. `claude-oauth-token` and `github-token` are injected
 * into worker containers at provision time; `github-repo` (owner/name) is the
 * repository the factory operates on.
 */
export const KNOWN_KEYS = ['claude-oauth-token', 'github-token', 'github-repo'] as const;
export type SettingKey = (typeof KNOWN_KEYS)[number];

export function isKnownKey(key: string): key is SettingKey {
  return (KNOWN_KEYS as readonly string[]).includes(key);
}

export async function getSetting(key: SettingKey): Promise<string | null> {
  const res = await query<{ value: string }>('select value from settings where key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

function preview(value: string): string {
  if (value.length <= 12) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export async function listSettings(): Promise<
  { key: string; set: boolean; preview: string | null; updatedAt: string | null }[]
> {
  const res = await query<{ key: string; value: string; updated_at: Date }>(
    'select key, value, updated_at from settings',
  );
  const byKey = new Map(res.rows.map((r) => [r.key, r]));
  return KNOWN_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      set: !!row,
      preview: row ? preview(row.value) : null,
      updatedAt: row ? row.updated_at.toISOString() : null,
    };
  });
}
