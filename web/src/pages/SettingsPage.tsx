import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getHealth, getOperatorToken, getSettings, putSetting, setOperatorToken } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Empty, ErrorNote, PageHeader, Panel, Spinner, StatusBadge } from '../components/ui';

const SETTING_HELP: Record<string, string> = {
  'claude-oauth-token': 'Claude subscription OAuth token — injected into worker containers.',
  'github-token': 'GitHub PAT (classic, repo scope) — branch/PR/issue operations.',
  'github-repo': 'Target repository, owner/name.',
};

function SettingEditor({ settingKey }: { settingKey: string }): React.ReactNode {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => putSetting(settingKey, value),
    onSuccess: () => {
      setValue('');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });
  const isSecret = settingKey !== 'github-repo';
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save.mutate();
      }}
    >
      <input
        type={isSecret ? 'password' : 'text'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={isSecret ? 'paste new value' : 'owner/name'}
        className="w-64 rounded-md border border-border bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={!value.trim() || save.isPending}
        className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium text-ink hover:bg-accent disabled:opacity-40"
      >
        {save.isPending ? 'saving…' : 'save'}
      </button>
      {save.isError && <span className="self-center text-xs text-err">{String(save.error)}</span>}
    </form>
  );
}

export default function SettingsPage(): React.ReactNode {
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 30_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const [token, setToken] = useState(getOperatorToken());

  return (
    <div>
      <PageHeader title="Settings & Health">
        {health.data && (
          <StatusBadge status={health.data.ready ? 'completed' : 'failed'} />
        )}
      </PageHeader>

      <div className="grid max-w-4xl gap-6 p-6">
        <Panel>
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">Health</div>
          {health.isLoading && <div className="p-4"><Spinner /></div>}
          {health.isError && <ErrorNote error={health.error} />}
          {health.data && (
            <ul className="divide-y divide-border">
              {Object.entries(health.data.checks).map(([name, check]) => (
                <li key={name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={`size-2 rounded-full ${check.ok ? 'bg-ok' : 'bg-err'}`} />
                  <span className="w-32 text-sm font-medium">{name}</span>
                  <span className="truncate text-xs text-dim" title={check.detail}>
                    {check.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">
            Factory settings
          </div>
          {settings.isLoading && <div className="p-4"><Spinner /></div>}
          {settings.isError && <ErrorNote error={settings.error} />}
          {settings.data?.length === 0 && <Empty>no settings</Empty>}
          <ul className="divide-y divide-border">
            {settings.data?.map((s) => (
              <li key={s.key} className="grid gap-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">{s.key}</span>
                  {s.set ? (
                    <span className="text-xs text-ok">
                      set · {s.preview} · {timeAgo(s.updatedAt)}
                    </span>
                  ) : (
                    <span className="text-xs text-err">not set</span>
                  )}
                </div>
                <p className="text-xs text-dim">{SETTING_HELP[s.key] ?? ''}</p>
                <SettingEditor settingKey={s.key} />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">
            Operator token (this browser)
          </div>
          <div className="grid gap-2 px-4 py-3">
            <p className="text-xs text-dim">
              Sent as a bearer token with every request. Only needed when the backend runs with
              OPERATOR_TOKEN set (e.g. on the VM); stored in this browser only.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="empty = no auth header"
                className="w-64 rounded-md border border-border bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => {
                  setOperatorToken(token.trim());
                  window.location.reload();
                }}
                className="rounded-md bg-accent-dim px-3 py-1.5 text-sm font-medium hover:bg-accent"
              >
                apply
              </button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
