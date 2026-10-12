// The 起始页 section of the settings page: which folder this browser shows, and
// how it opens.
//
// Choosing a source is a local decision. A device may display a folder of a
// space it already syncs, and it can read that whole space through its own
// credential already, so naming one folder inside it needs no approval — and
// therefore no account password (start-page doc §11.2 as implemented).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { createRuntime, errText } from './runtime';
import { chromeApi } from '../runtime/chromeApi';
import { clearStartPage, patchConfig, saveSource } from '../core/start-page/provider';
import type { StartPageConfigRecord } from '../core/store/db';
import type { ParentRefWire } from '../core/protocol/types';

const runtime = createRuntime();
const deps = { db: runtime.db, bootstrap: runtime.bootstrap, client: runtime.client };

/** One folder the reader could choose, with the titles above it so two folders
 * named 开发 can be told apart. */
interface FolderChoice {
  id: string;
  title: string;
  trail: string[];
  /** How many direct children it has, for the row's hint. */
  children: number;
}

export function StartPageSettings({ onChanged }: { onChanged?: () => void }) {
  const [config, setConfig] = useState<StartPageConfigRecord | null>(null);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Spaces this device actually syncs, with the binding that grants the read. */
  const [synced, setSynced] = useState<{ value: string; label: string; bindingId: string }[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [folders, setFolders] = useState<FolderChoice[]>([]);
  const [picked, setPicked] = useState('');
  const [loadingTree, setLoadingTree] = useState(false);

  const reload = useCallback(async () => {
    const b = await runtime.bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken && b.instanceId && b.deviceId));
    if (!b.instanceId || !b.deviceId) {
      setConfig(null);
      return;
    }
    const row = (await runtime.db.startPageConfigs.get(`${b.instanceId}:${b.deviceId}`)) ?? null;
    setConfig(row);
    if (row?.spaceId) setSpaceId(row.spaceId);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The selectable spaces are this device's active bindings — read from the
  // local replica, where the sync engine already keeps them. Not every space
  // the account owns: the start page reads through a binding, and a space this
  // browser never subscribed to is not its to display.
  useEffect(() => {
    if (!paired) return;
    let cancelled = false;
    void runtime.db.bindings.toArray().then((rows) => {
      if (cancelled) return;
      const active = rows.filter((r) => r.state === 'active' && r.enabled !== false);
      setSynced(
        active.map((r) => ({
          value: r.spaceId,
          label: r.spaceName || r.spaceId,
          bindingId: r.id,
        })),
      );
      setSpaceId((current) => current || active[0]?.spaceId || '');
    });
    return () => {
      cancelled = true;
    };
  }, [paired]);

  const bindingId = useMemo(
    () => synced.find((s) => s.value === spaceId)?.bindingId ?? '',
    [synced, spaceId],
  );

  // Reading the binding's snapshot is what makes the folder list possible. It
  // is a settings-time read of a space this device already holds the right to
  // read in full — not something the start page itself ever does.
  useEffect(() => {
    if (!bindingId) {
      setFolders([]);
      return;
    }
    let cancelled = false;
    setLoadingTree(true);
    setError(null);
    void runtime.client
      .fetchSnapshot(bindingId)
      .then((snap) => {
        if (cancelled) return;
        const byId = new Map(snap.nodes.map((n) => [n.id, n]));
        const kids = new Map<string, number>();
        for (const n of snap.nodes) {
          const parent = n.parent.type === 'node' ? n.parent.id ?? '' : '';
          kids.set(parent, (kids.get(parent) ?? 0) + 1);
        }
        const trailOf = (node: { parent: ParentRefWire }): string[] => {
          const out: string[] = [];
          for (
            let at = node.parent.type === 'node' ? byId.get(node.parent.id ?? '') : undefined;
            at;
            at = at.parent.type === 'node' ? byId.get(at.parent.id ?? '') : undefined
          ) {
            out.unshift(at.title);
            if (out.length > snap.nodes.length) break;
          }
          return out;
        };
        setFolders(
          snap.nodes
            .filter((n) => n.type === 'folder')
            .map((n) => ({
              id: n.id,
              title: n.title,
              trail: trailOf(n),
              children: kids.get(n.id) ?? 0,
            })),
        );
        setPicked('');
      })
      .catch((err) => !cancelled && setError(errText(err)))
      .finally(() => !cancelled && setLoadingTree(false));
    return () => {
      cancelled = true;
    };
  }, [bindingId]);

  const save = async () => {
    if (!picked || !spaceId) return;
    setBusy('save');
    setError(null);
    try {
      // Read the chosen folder once, through the same call the page will use.
      // A source that cannot be read should not become the thing the page is
      // configured to show (§8.2).
      const read = await runtime.client.deviceStartPageSnapshot(spaceId, picked);
      if (typeof read.value === 'symbol') {
        setError('这个目录读不到内容，来源没有切换。');
        return;
      }
      await saveSource(deps, { spaceId, folderId: picked }, read.value);
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
      // Releasing the display is the reader's decision made now, locally. The
      // cached tree goes with it; the binding is untouched, because a start
      // page and a sync subscription are different decisions (§5.3).
      await clearStartPage(runtime.db, config.deviceId);
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
        起始页显示的是这台设备已同步空间里的书签。请先在「账号管理」完成配对。
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
              {config ? `${config.spaceId} / ${config.folderId}` : '还没有选择要显示的文件夹。'}
            </Text>
            {config ? (
              <Text size="xs" c="dimmed" mt={2}>
                更新于 {new Date(config.updatedAt).toLocaleString('zh-CN')}
              </Text>
            ) : null}
          </Box>
          <Button variant="light" component="a" href={chromeApi().runtime.getURL('start-page.html')} target="_blank">
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

      {synced.length === 0 ? (
        <Alert color="amber" variant="light" title="这台设备还没有已同步的空间">
          起始页只显示这台浏览器已经同步的空间里的目录。请先在「同步管理」绑定一个空间并完成初始化。
        </Alert>
      ) : (
        <Stack gap="sm">
          <Select
            label="空间"
            description="只显示这台设备已建立同步绑定的空间。"
            data={synced.map((s) => ({ value: s.value, label: s.label }))}
            value={spaceId}
            onChange={(v) => setSpaceId(v ?? '')}
          />

          <Box>
            <Group gap="xs" mb="xs">
              <Text size="xs" fw={500}>
                文件夹
              </Text>
              {loadingTree ? <Loader size="xs" /> : null}
            </Group>
            <ScrollArea h={240} type="auto" className="pontis-listBox">
              {loadingTree ? (
                <Text size="sm" c="dimmed" p="sm">
                  正在读取目录……
                </Text>
              ) : folders.length === 0 ? (
                // "This space has no folders" is a claim about the account;
                // it must not be shown while the read is still running (§8.2).
                <Text size="sm" c="dimmed" p="sm">
                  这个空间里还没有文件夹。
                </Text>
              ) : (
                folders.map((f) => (
                  <Group key={f.id} gap="xs" wrap="nowrap" px="sm">
                    <Radio
                      name="start-page-folder"
                      checked={picked === f.id}
                      onChange={() => setPicked(f.id)}
                      aria-label={f.title}
                    />
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Text size="sm" truncate>
                        {f.trail.length ? `${f.trail.join(' / ')} / ${f.title}` : f.title}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {f.children} 个直接子项
                      </Text>
                    </Box>
                  </Group>
                ))
              )}
            </ScrollArea>
          </Box>

          <Group justify="space-between">
            {config ? (
              <Button variant="subtle" color="red" size="xs" loading={busy === 'release'} onClick={() => void release()}>
                解除来源
              </Button>
            ) : (
              <span />
            )}
            <Button disabled={!picked} loading={busy === 'save'} onClick={() => void save()}>
              设为来源
            </Button>
          </Group>
        </Stack>
      )}

      <Divider label="新标签页" labelPosition="left" />

      {/* Which artifact is installed is not visible from the icon and cannot be
          changed from inside the extension, so the page says it plainly rather
          than offering a toggle that would lie (§8.3). */}
      <Text size="sm" c="dimmed">
        {typeof __PONTIS_NEWTAB_BUILD__ !== 'undefined' && __PONTIS_NEWTAB_BUILD__
          ? '当前安装的是接管版本：新标签页会显示 Pontis 起始页。要恢复浏览器原来的新标签页，停用或卸载本扩展即可；扩展内没有这个开关。若新标签页仍是浏览器原来的样子，多半是浏览器在装入或更新时把它停用了——到扩展管理页点「启用」即可，每次更新后可能需要再点一次。'
          : '当前安装的是标准同步版本，不会接管新标签页。想让新标签页显示 Pontis 起始页，请另行安装「Pontis (起始页)」构建；停用本扩展不会影响浏览器原有的新标签页。'}
      </Text>

      <Divider label="显示" labelPosition="left" />

      {config ? (
        <Group grow>
          <Select
            label="打开方式"
            description="也用于网页搜索结果。"
            data={[
              { value: 'current-tab', label: '当前标签页' },
              { value: 'new-tab', label: '新标签页' },
            ]}
            value={config.openTarget}
            onChange={(v) => void patch({ openTarget: (v as 'current-tab' | 'new-tab') ?? 'current-tab' })}
          />
          <Select
            label="密度"
            data={[
              { value: 'standard', label: '标准' },
              { value: 'compact', label: '紧凑' },
            ]}
            value={config.density}
            onChange={(v) => void patch({ density: (v as 'standard' | 'compact') ?? 'standard' })}
          />
        </Group>
      ) : null}
    </Stack>
  );
}
