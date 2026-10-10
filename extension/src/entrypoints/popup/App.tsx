// Popup: binding status at a glance + manual sync (doc 05 §15 trigger).

import { useEffect, useState } from 'react';
import { Badge, Button, Card, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { PontisDB, type BindingRecord } from '../../core/store/db';
import { chromeApi } from '../../runtime/chromeApi';
import { bindingStatus, relTime } from '../../ui/bindingStatus';

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
      <Stack className="pontis-popup" p="md" gap="sm">
        <Title order={4} fw={600}>
          Pontis
        </Title>
        <Text size="sm" c="dimmed">
          尚未绑定同步空间。请先在扩展选项页完成配对与绑定。
        </Text>
        <Button component="a" href={chromeApi().runtime.getURL('options.html')} target="_blank" variant="light">
          打开选项页
        </Button>
      </Stack>
    );
  }

  const waiting = bindings.filter((b) => b.state === 'waiting_user');

  return (
    <Stack className="pontis-popup" gap="xs">
      <Group justify="space-between" wrap="nowrap" px="md" pt="md" pb="xs">
        <Title order={4} fw={600}>
          Pontis 同步
        </Title>
        {waiting.length > 0 && (
          <Badge color="warningAmber" variant="filled">
            {`${waiting.length} 项待确认`}
          </Badge>
        )}
      </Group>
      <Divider />

      <Stack gap="xs" px="md">
        {bindings.map((b) => {
          const st = bindingStatus(b);
          return (
            <Card key={b.id} withBorder radius="sm" padding="xs" bg="var(--mantine-color-body)">
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm" fw={600} truncate>
                  {b.spaceName}
                </Text>
                <Badge color={st.color} variant="light">
                  {st.label}
                </Badge>
              </Group>
              <Group gap="xs" wrap="nowrap" justify="space-between">
                <Text size="xs" c="dimmed" className="pontis-numerals">
                  {b.appliedRevision} / {b.receivedRevision} · epoch {b.epoch}
                </Text>
                <Text size="xs" c="dimmed">
                  {relTime(b.lastSyncAt)}
                </Text>
              </Group>
              {st.catchingUp && (
                <Text size="xs" c="recoveryOrange">
                  尚有 {st.pending} 项未落地
                </Text>
              )}
              {b.recovery && (
                <Text size="xs" c="errorRed">
                  需要恢复: {b.recovery.code}
                </Text>
              )}
            </Card>
          );
        })}
      </Stack>

      {syncError && (
        <Text size="xs" c="errorRed" px="md">
          {syncError}
        </Text>
      )}

      <Group px="md" pb="md" pt="xs">
        <Button loading={syncing} onClick={() => void manualSync} style={{ flexGrow: 1 }}>
          立即同步
        </Button>
      </Group>
    </Stack>
  );
}
