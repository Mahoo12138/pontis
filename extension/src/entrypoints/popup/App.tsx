// Popup: binding status at a glance + manual sync (doc 05 §15 trigger).

import { useEffect, useState } from 'react';
import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { PontisDB, type BindingRecord } from '../../core/store/db';
import { chromeApi } from '../../runtime/chromeApi';

export function App() {
  const [bindings, setBindings] = useState<BindingRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    const db = new PontisDB();
    const load = () => db.bindings.toArray().then(setBindings);
    void load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  const manualSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const resp = (await chromeApi().runtime.sendMessage({ type: 'pontis/manual-sync' })) as
        | { ok: boolean; error?: string }
        | undefined;
      if (resp && !resp.ok) setSyncError(resp.error ?? 'sync failed');
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  if (bindings.length === 0) {
    return (
      <Stack p="md" gap="sm">
        <Title order={4}>Pontis</Title>
        <Text size="sm" c="dimmed">
          尚未绑定同步空间。请先在扩展选项页完成配对与绑定。
        </Text>
        <Button component="a" href={chromeApi().runtime.getURL('options.html')} target="_blank" variant="light">
          打开选项页
        </Button>
      </Stack>
    );
  }

  return (
    <Stack p="md" gap="sm">
      <Title order={4}>Pontis 同步</Title>
      {bindings.map((b) => (
        <Stack key={b.id} gap={4}>
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {b.spaceName}
            </Text>
            <StateBadge state={b.state} />
          </Group>
          <Text size="xs" c="dimmed">
            epoch {b.epoch} · applied {b.appliedRevision} / received {b.receivedRevision}
            {b.lastSyncAt ? ` · ${new Date(b.lastSyncAt).toLocaleTimeString()}` : ' · 未同步'}
          </Text>
          {b.recovery && (
            <Text size="xs" c="red">
              需要恢复: {b.recovery.code}
            </Text>
          )}
        </Stack>
      ))}
      {syncError && (
        <Text size="xs" c="red">
          {syncError}
        </Text>
      )}
      <Button loading={syncing} onClick={() => void manualSync()}>
        立即同步
      </Button>
    </Stack>
  );
}

function StateBadge({ state }: { state: BindingRecord['state'] }) {
  const map: Record<BindingRecord['state'], { color: string; label: string }> = {
    active: { color: 'green', label: '同步中' },
    paused: { color: 'gray', label: '已暂停' },
    mount_missing: { color: 'orange', label: '目录缺失' },
    needs_recovery: { color: 'red', label: '需要恢复' },
    initializing: { color: 'blue', label: '初始化中' },
    resyncing: { color: 'blue', label: '重新同步中' },
    waiting_user: { color: 'yellow', label: '等待确认' },
  };
  const s = map[state];
  return (
    <Badge color={s.color} variant="light" size="sm">
      {s.label}
    </Badge>
  );
}
