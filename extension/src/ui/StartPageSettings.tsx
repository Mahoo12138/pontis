// The 起始页 section of the settings page: which folder this browser shows, and
// how it opens.
//
// Approving a source is deliberately an account action. The extension's
// standing device credential is what *reads* the approved folder; if it could
// also pick one, the approval would describe nothing (start-page doc §11.2). So
// this form asks for the account password the same way pairing does, uses the
// short-lived session token to approve, and keeps nothing of it.

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  PasswordInput,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { createRuntime, errText } from './runtime';
import { chromeApi } from '../runtime/chromeApi';
import { clearStartPage, patchConfig, saveSource, snapshotIdFor } from '../core/start-page/provider';
import type { StartPageConfigRecord } from '../core/store/db';
import type { StartPageFolderWire } from '../core/start-page/wire';

const runtime = createRuntime();
const deps = { db: runtime.db, bootstrap: runtime.bootstrap, client: runtime.client };

/** A folder plus the titles of the folders above it, for the row label. The
 * ids alone would not tell 开发-in-日常入口 from 开发-in-工作. */
interface FolderChoice extends StartPageFolderWire {
  trail: string[];
}

export function StartPageSettings({ onChanged }: { onChanged?: () => void }) {
  const [config, setConfig] = useState<StartPageConfigRecord | null>(null);
  /** The names beside the ids, from the copy that is currently installed: a
   * source is chosen by id, but it is confirmed to the user by name. */
  const [sourceNames, setSourceNames] = useState<{ space: string; folder: string } | null>(null);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The approval flow's own state; nothing here outlives the save.
  const [authorizing, setAuthorizing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [spaces, setSpaces] = useState<{ value: string; label: string }[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [folders, setFolders] = useState<FolderChoice[]>([]);
  const [picked, setPicked] = useState('');
  const [serverUrl, setServerUrl] = useState('');

  const reload = useCallback(async () => {
    const b = await runtime.bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken && b.instanceId && b.deviceId));
    setServerUrl(b.serverUrl ?? '');
    if (!b.instanceId || !b.deviceId) {
      setConfig(null);
      return;
    }
    const row = (await runtime.db.startPageConfigs.get(`${b.instanceId}:${b.deviceId}`)) ?? null;
    setConfig(row);
    if (!row) {
      setSourceNames(null);
      return;
    }
    const snapshot = await runtime.db.startPageSnapshots.get(
      snapshotIdFor(row.instanceId, row.userId, row.deviceId, row.grantId, row.grantVersion, row.spaceId, row.folderId),
    );
    setSourceNames(snapshot ? { space: snapshot.spaceName, folder: snapshot.sourceTitle } : null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const begin = async () => {
    setError(null);
    setBusy('authorize');
    try {
      // The origin has to be granted before any fetch can reach it; pairing
      // already asked for it, so this only matters after a server move.
      const granted = await requestOriginPermission(serverUrl);
      if (!granted) {
        setError('没有该 Server 的访问权限，无法读取目录。');
        return;
      }
      const login = await runtime.client.login(username, password, serverUrl);
      setSessionToken(login.token);
      const list = await runtime.client.sessionSpaces(login.token, serverUrl);
      setSpaces(list.map((sp) => ({ value: sp.id, label: sp.name })));
      setSpaceId(list[0]?.id ?? '');
      // The password has done its one job; it is not held for a later click.
      setPassword('');
      setAuthorizing(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!sessionToken || !spaceId) return;
    let cancelled = false;
    void runtime.client
      .sessionFolders(sessionToken, spaceId, serverUrl)
      .then((rows) => {
        if (cancelled) return;
        const byId = new Map(rows.map((r) => [r.id, r]));
        setFolders(
          rows.map((row) => {
            const trail: string[] = [];
            for (let at = byId.get(row.parent_id ?? ''); at; at = byId.get(at.parent_id ?? '')) {
              trail.unshift(at.title);
              if (trail.length > rows.length) break;
            }
            return { ...row, trail };
          }),
        );
        setPicked('');
      })
      .catch((err) => !cancelled && setError(errText(err)));
    return () => {
      cancelled = true;
    };
  }, [sessionToken, spaceId, serverUrl]);

  const save = async () => {
    if (!sessionToken || !picked) return;
    setBusy('save');
    setError(null);
    try {
      const b = await runtime.bootstrap.get();
      const source = await runtime.client.authorizeStartPageGrant(sessionToken, {
        device_id: b.deviceId ?? '',
        space_id: spaceId,
        folder_id: picked,
      });
      // Read it once before the choice is saved: a source that cannot be read
      // should not become the thing the page is configured to show (§8.2).
      const read = await runtime.client.deviceStartPageSnapshot();
      if (typeof read.value === 'symbol') {
        setError('来源已批准，但首次读取没有返回内容。请重试。');
        return;
      }
      await saveSource(deps, source, read.value);
      setSessionToken('');
      setAuthorizing(false);
      setFolders([]);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const release = async () => {
    if (!config) return;
    setBusy('release');
    setError(null);
    try {
      // Releasing the display authorization is the user's decision made now,
      // locally: the cached tree goes immediately, and the server-side grant
      // stays for the account to revoke where it owns one.
      await clearStartPage(runtime.db, config.deviceId);
      await runtime.db.startPageConfigs.delete(config.id);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const patch = async (next: Partial<Pick<StartPageConfigRecord, 'openTarget' | 'density'>>) => {
    const updated = await patchConfig(deps, next);
    if (updated) setConfig(updated);
    onChanged?.();
  };

  if (!paired) {
    return (
      <Alert color="blue" variant="light" title="还没有配对">
        起始页需要一个已配对的设备：来源是针对这台设备批准的。请先在「账号管理」完成配对。
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      <Box className="pontis-block">
        <Group justify="space-between" wrap="nowrap">
          <Box>
            <Text fw={600}>当前来源</Text>
            <Text size="sm" c="dimmed">
              {config
                ? sourceNames
                  ? `${sourceNames.space} / ${sourceNames.folder}`
                  : '已选择来源，但本地还没有它的快照。'
                : '还没有选择要显示的文件夹。'}
            </Text>
            {config ? (
              <Text size="xs" c="dimmed" mt={2}>
                授权版本 {config.grantVersion} · 更新于 {new Date(config.updatedAt).toLocaleString('zh-CN')}
              </Text>
            ) : null}
          </Box>
          <Button
            variant="light"
            component="a"
            href={chromeApi().runtime.getURL('start-page.html')}
            target="_blank"
          >
            预览起始页
          </Button>
        </Group>
      </Box>

      {error ? (
        <Alert color="red" variant="light" title="操作未完成">
          {error}
        </Alert>
      ) : null}

      <Divider label="选择来源" labelPosition="left" />

      {authorizing ? (
        <Stack gap="sm">
          <Group gap="sm" align="flex-end" wrap="nowrap">
            <Select
              label="空间"
              data={spaces}
              value={spaceId}
              onChange={(v) => setSpaceId(v ?? '')}
              style={{ flex: '0 0 220px' }}
            />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text size="xs" fw={500} mb={4}>
                文件夹
              </Text>
              <ScrollArea h={180} type="auto" className="pontis-listBox">
                {folders.length === 0 ? (
                  <Text size="sm" c="dimmed" p="xs">
                    这个空间里没有可选的文件夹。
                  </Text>
                ) : (
                  folders.map((f) => (
                    <Group key={f.id} gap="xs" wrap="nowrap" px="xs">
                      <input
                        type="radio"
                        name="start-page-folder"
                        checked={picked === f.id}
                        onChange={() => setPicked(f.id)}
                        id={`sp-folder-${f.id}`}
                      />
                      <Box component="label" htmlFor={`sp-folder-${f.id}`} style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}>
                        <Text size="sm" truncate>
                          {f.trail.length ? `${f.trail.join(' / ')} / ${f.title}` : f.title}
                        </Text>
                      </Box>
                    </Group>
                  ))
                )}
              </ScrollArea>
            </Box>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              这里读取的是账户自己的目录树；起始页运行时使用的设备凭据不会因此获得更广的范围。
            </Text>
            <Group>
              <Button
                variant="default"
                onClick={() => {
                  setAuthorizing(false);
                  setSessionToken('');
                }}
              >
                取消
              </Button>
              <Button disabled={!picked} loading={busy === 'save'} onClick={() => void save()}>
                批准并保存
              </Button>
            </Group>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Group gap="sm" align="flex-end" wrap="nowrap">
            <TextInput
              label="账户"
              description="用于确认这次来源变更，凭据不会被保存。"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              style={{ flex: '0 0 220px' }}
            />
            <PasswordInput
              label="密码"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              style={{ flex: '0 0 220px' }}
            />
            <Button
              disabled={!username || !password}
              loading={busy === 'authorize'}
              onClick={() => void begin()}
            >
              读取目录
            </Button>
          </Group>
          {config ? (
            <Group gap="md">
              <Button variant="subtle" color="red" size="xs" loading={busy === 'release'} onClick={() => void release()}>
                解除来源
              </Button>
              <Text size="xs" c="dimmed">
                解除只停止起始页的显示，不会解除该空间的同步绑定。
              </Text>
            </Group>
          ) : null}
        </Stack>
      )}

      <Divider label="显示" labelPosition="left" />

      {authorizing || !config ? null : (
        <Group gap="lg">
          <Select
            label="打开方式"
            data={[
              { value: 'current-tab', label: '当前标签页' },
              { value: 'new-tab', label: '新标签页' },
            ]}
            value={config.openTarget}
            onChange={(v) => void patch({ openTarget: (v as 'current-tab' | 'new-tab') ?? 'current-tab' })}
            style={{ flex: '0 0 200px' }}
          />
          <Select
            label="密度"
            data={[
              { value: 'standard', label: '标准' },
              { value: 'compact', label: '紧凑' },
            ]}
            value={config.density}
            onChange={(v) => void patch({ density: (v as 'standard' | 'compact') ?? 'standard' })}
            style={{ flex: '0 0 200px' }}
          />
        </Group>
      )}

      {authorizing ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            正在读取账户目录……
          </Text>
        </Group>
      ) : null}
    </Stack>
  );
}

/** Ask for the paired server's origin, the way pairing does. */
async function requestOriginPermission(serverUrl: string): Promise<boolean> {
  const chrome = chromeApi();
  const pattern = `${new URL(serverUrl).protocol}//${new URL(serverUrl).hostname}${
    new URL(serverUrl).port ? `:${new URL(serverUrl).port}` : ''
  }/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [pattern] }, (granted) => resolve(granted));
  });
}
