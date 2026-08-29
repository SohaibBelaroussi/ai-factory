import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getHealth, getOperatorToken, getSettings, putSetting, setOperatorToken } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Empty, ErrorNote, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { cn } from '@/lib/utils';

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
      <Input
        className="max-w-72"
        onChange={(e) => setValue(e.target.value)}
        placeholder={isSecret ? 'paste new value' : 'owner/name'}
        type={isSecret ? 'password' : 'text'}
        value={value}
      />
      <Button disabled={!value.trim() || save.isPending} size="sm" type="submit" variant="secondary">
        {save.isPending ? 'saving…' : 'save'}
      </Button>
      {save.isError && <span className="self-center text-destructive text-xs">{String(save.error)}</span>}
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
        {health.data && <StatusBadge status={health.data.ready ? 'ready' : 'not ready'} />}
      </PageHeader>

      <div className="mx-auto grid max-w-4xl gap-6 p-8 pt-6">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border py-4">
            <CardTitle className="font-display text-base">Health</CardTitle>
          </CardHeader>
          {health.isLoading && (
            <div className="p-5">
              <Spinner />
            </div>
          )}
          {health.isError && <ErrorNote error={health.error} />}
          {health.data && (
            <ul className="divide-y divide-border">
              {Object.entries(health.data.checks).map(([name, check]) => (
                <li className="flex items-center gap-3 px-5 py-3" key={name}>
                  <span
                    className={cn('size-2 rounded-full', check.ok ? 'bg-emerald-500' : 'bg-red-500')}
                  />
                  <span className="w-32 text-sm font-medium">{name}</span>
                  <span className="truncate text-muted-foreground text-xs" title={check.detail}>
                    {check.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border py-4">
            <CardTitle className="font-display text-base">Factory settings</CardTitle>
            <CardDescription>
              Secrets live in the factory's database, never in files. Values are shown masked.
            </CardDescription>
          </CardHeader>
          {settings.isLoading && (
            <div className="p-5">
              <Spinner />
            </div>
          )}
          {settings.isError && <ErrorNote error={settings.error} />}
          {settings.data?.length === 0 && <Empty>no settings</Empty>}
          <ul className="divide-y divide-border">
            {settings.data?.map((s) => (
              <li className="grid gap-2 px-5 py-4" key={s.key}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm">{s.key}</span>
                  {s.set ? (
                    <span className="text-emerald-700 text-xs dark:text-emerald-400">
                      set · {s.preview} · {timeAgo(s.updatedAt)}
                    </span>
                  ) : (
                    <span className="text-destructive text-xs">not set</span>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">{SETTING_HELP[s.key] ?? ''}</p>
                <SettingEditor settingKey={s.key} />
              </li>
            ))}
          </ul>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b border-border py-4">
            <CardTitle className="font-display text-base">Operator token (this browser)</CardTitle>
            <CardDescription>
              Sent as a bearer with every request. Only needed when the backend runs with
              OPERATOR_TOKEN set (e.g. on the VM); stored in this browser only.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="flex gap-2">
              <Input
                className="max-w-72"
                onChange={(e) => setToken(e.target.value)}
                placeholder="empty = no auth header"
                type="password"
                value={token}
              />
              <Button
                onClick={() => {
                  setOperatorToken(token.trim());
                  window.location.reload();
                }}
                size="sm"
                variant="secondary"
              >
                apply
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
