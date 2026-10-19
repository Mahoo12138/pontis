// Popup: binding status at a glance + manual sync (doc 05 §15 trigger).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Badge, Box, Button, Group, Stack, Text, Title } from '@mantine/core';
import { PontisDB, type BindingRecord } from '../../core/store/db';
import { createChromiumAdapter } from '../../core/browser/chromium';
import { countScopeBookmarks } from '../../core/browser/scopeCount';
import { chromeApi } from '../../runtime/chromeApi';
import { bindingStatus, recoveryNote, relTime, sortBindings } from '../../ui/bindingStatus';
import { PontisLogo } from '../../ui/PontisLogo';

export function App() {
  const [bindings, setBindings] = useState<BindingRecord[]>([]);
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const counting = useRef(false);

  const refreshCounts = useCallback(async (rows: BindingRecord[]) => {
    if (rows.length === 0 || counting.current) return;
    // The count is read from the browser, so it moves while the popup is open.
    // One pass at a time: a slow tree must not stack scans behind the 2s poll.
    counting.current = true;
    const adapter = createChromiumAdapter(chromeApi().bookmarks);
    try {
      const next: Record<string, number | null> = {};
      await Promise.all(
        rows.map(async (b) => {
          next[b.id] = await countScopeBookmarks(adapter, b.mount);
        }),
      );
      setCounts(next);
    } finally {
      counting.current = false;
    }
  }, []);

  useEffect(() => {
    const db = new PontisDB();
    const load = () =>
      db.bindings.toArray().then((rows) => {
        setBindings(rows);
        void refreshCounts(rows);
      });
    void load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [refreshCounts]);

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
      // A round may have just written bookmarks into the browser.
      void refreshCounts(bindings);
    }
  };

  if (bindings.length === 0) {
    return (
      <Stack className="pontis-popup" p="md" gap="sm">
        <Group gap="xs">
          <PontisLogo size={22} alt="Pontis" />
          <Title order={4} fw={600}>
            Pontis
          </Title>
        </Group>
        <Text size="sm" c="dimmed">
          还没有配对，也还没有绑定任何空间。
        </Text>
        <Button component="a" href={chromeApi().runtime.getURL('onboarding.html')} target="_blank" variant="light">
          打开初始设置
        </Button>
      </Stack>
    );
  }

  const waiting = bindings.filter((b) => b.state === 'waiting_user');
  const allOff = bindings.every((b) => b.enabled === false);

  return (
    <Stack className="pontis-popup" gap="xs">
      <Group justify="space-between" wrap="nowrap" px="md" pt="md" pb="xs">
        <Group gap="xs" wrap="nowrap">
          <PontisLogo size={22} alt="Pontis" />
          <Title order={4} fw={600}>
            Pontis 同步
          </Title>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {waiting.length > 0 && (
            <Badge color="warningAmber" variant="filled">
              {`${waiting.length} 个空间待确认`}
            </Badge>
          )}
          <ActionIcon
            component="a"
            href={chromeApi().runtime.getURL('options.html')}
            target="_blank"
            variant="subtle"
            color="gray"
            size="md"
            aria-label="打开设置页"
            title="打开设置页"
          >
            <SettingsGlyph />
          </ActionIcon>
        </Group>
      </Group>

      <Box className="pontis-listBox" mx="md">
        {sortBindings(bindings).map((b) => {
          const st = bindingStatus(b);
          const count = counts[b.id];
          return (
            <Box key={b.id} className="pontis-block">
              <Group justify="space-between" wrap="nowrap">
                {/* The name gives room, never the badge: a status shortened to
                    "监…" stops telling anyone anything. */}
                <Text size="sm" fw={600} truncate style={{ minWidth: 0 }}>
                  {b.spaceName}
                </Text>
                <Badge color={st.color} variant="light" style={{ flexShrink: 0 }}>
                  {st.label}
                </Badge>
              </Group>
              <Group gap="xs" wrap="nowrap" justify="space-between">
                <Text size="xs" c="dimmed" className="pontis-numerals">
                  {count === null || count === undefined
                    ? '读不到这个目录'
                    : `${count} 个书签`}
                </Text>
                <Text size="xs" c="dimmed">
                  {relTime(b.lastSyncAt)}
                </Text>
              </Group>
              {st.disabled && (
                <Text size="xs" c="dimmed">
                  同步已关闭，本机的改动会攒着
                </Text>
              )}
              {!st.disabled && st.pending > 0 && (
                <Text size="xs" c="recoveryOrange">
                  还有 {st.pending} 项远端改动没落到浏览器
                </Text>
              )}
              {b.recovery && (
                <Text size="xs" c="errorRed">
                  {recoveryNote(b)}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      {syncError && (
        <Text size="xs" c="errorRed" px="md">
          {syncError}
        </Text>
      )}

      <Stack gap={4} px="md" pb="md" pt="xs">
        <Button
          loading={syncing}
          disabled={allOff}
          onClick={() => void manualSync()}
          style={{ flexGrow: 1 }}
        >
          立即同步
        </Button>
        {allOff && (
          <Text size="xs" c="dimmed">
            每个空间的同步都关着，这里不会上传或下载任何东西
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/** The settings mark: two rails with a knob each. Drawn inline rather than
 * pulled from an icon package because this is the third glyph the extension
 * needs in total, and a dependency for one 16px path is not worth the bundle. */
function SettingsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <path
        d="M2 4.5h7M12.5 4.5H14M2 11.5h2.5M8.5 11.5H14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="10.75" cy="4.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.25" cy="11.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
