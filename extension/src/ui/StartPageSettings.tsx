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
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { createRuntime, errText } from './runtime';
import { chromeApi } from '../runtime/chromeApi';
import { FolderPickerField } from './FolderPickerField';
import { buildFolderTree, type FolderTreeNode } from './folderTree';
import { clearStartPage, patchConfig, saveSource } from '../core/start-page/provider';
import {
  BACKGROUND_ERROR_TEXT,
  defaultAppearance,
  greetingFor,
  loadAppearance,
  prepareBackground,
  publishAppearanceChange,
  saveAppearance,
} from '../core/start-page/appearance';
import type { StartPageAppearanceRecord, StartPageConfigRecord } from '../core/store/db';

const runtime = createRuntime();
const deps = { db: runtime.db, bootstrap: runtime.bootstrap, client: runtime.client };

export function StartPageSettings({ onChanged }: { onChanged?: () => void }) {
  const [config, setConfig] = useState<StartPageConfigRecord | null>(null);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Spaces this device actually syncs, with the binding that grants the read. */
  const [synced, setSynced] = useState<{ value: string; label: string; bindingId: string }[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [picked, setPicked] = useState('');
  const [loadingTree, setLoadingTree] = useState(false);

  const [appearance, setAppearance] = useState<StartPageAppearanceRecord>(() => defaultAppearance(''));
  const [titleDraft, setTitleDraft] = useState('');
  const [opacityDraft, setOpacityDraft] = useState(0);

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
    const look = row ? await loadAppearance(runtime.db, row.id) : defaultAppearance('');
    setAppearance(look);
    setTitleDraft(look.titleText);
    setOpacityDraft(Math.round(look.backgroundOpacity * 100));
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

  // Reading the binding's snapshot is what makes the folder tree possible. It
  // is a settings-time read of a space this device already holds the right to
  // read in full — not something the start page itself ever does.
  useEffect(() => {
    if (!bindingId) {
      setTree([]);
      return;
    }
    let cancelled = false;
    setLoadingTree(true);
    setError(null);
    void runtime.client
      .fetchSnapshot(bindingId)
      .then((snap) => {
        if (cancelled) return;
        setTree(buildFolderTree(snap.nodes));
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

  // Appearance writes go straight to the row the start page reads, and announce
  // themselves through chrome.storage so an already-open page repaints. Nothing
  // here touches the source or the cached tree.
  const applyAppearance = async (
    patch: Partial<Pick<StartPageAppearanceRecord, 'titleText' | 'background' | 'backgroundOpacity'>>,
  ) => {
    if (!config) return null;
    const next = await saveAppearance(runtime.db, config.id, patch);
    setAppearance(next);
    await publishAppearanceChange(chromeApi().storage.local, config.id);
    return next;
  };

  const saveTitle = async (text: string) => {
    if (!config || text === appearance.titleText) return;
    const next = await applyAppearance({ titleText: text.slice(0, 60) });
    if (next) setTitleDraft(next.titleText);
  };

  const chooseBackground = async (file: File | undefined) => {
    if (!config || !file) return;
    setBusy('background');
    setError(null);
    try {
      const prepared = await prepareBackground(file);
      if ('error' in prepared) {
        setError(BACKGROUND_ERROR_TEXT[prepared.error]);
        return;
      }
      await applyAppearance({ background: prepared.dataUrl });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const removeBackground = () => void applyAppearance({ background: null });

  const saveOpacity = (percent: number) => void applyAppearance({ backgroundOpacity: percent / 100 });

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

          <FolderPickerField
            tree={tree}
            value={picked}
            onChange={setPicked}
            label="文件夹"
            description="起始页只显示这个文件夹里的书签，子文件夹算在里面。"
            loading={loadingTree}
            revealId={config?.folderId}
            groupName="start-page-folder"
          />

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

      <Divider label="外观" labelPosition="left" />

      {config ? (
        <Stack gap="sm">
          <TextInput
            label="标题"
            maw={360}
            maxLength={60}
            placeholder={greetingFor(new Date())}
            description={`留空则按时间显示问候语，现在是「${greetingFor(new Date())}」。`}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.currentTarget.value)}
            onBlur={() => void saveTitle(titleDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveTitle(titleDraft);
              }
            }}
          />

          <Box>
            <Text size="sm" fw={500} mb={6}>
              背景图片
            </Text>
            <Group gap="sm" wrap="nowrap" align="flex-start">
              {appearance.background ? (
                <img className="pontis-spBgThumb" src={appearance.background} alt="当前背景预览" />
              ) : (
                <Box className="pontis-spBgThumb pontis-spBgThumbEmpty" />
              )}
              <Stack gap={4}>
                <Group gap="xs">
                  <Button size="xs" variant="light" loading={busy === 'background'} component="label">
                    选择图片
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => {
                        void chooseBackground(e.currentTarget.files?.[0]);
                        // So picking the same file again still fires a change.
                        e.currentTarget.value = '';
                      }}
                    />
                  </Button>
                  {appearance.background ? (
                    <Button size="xs" variant="subtle" color="gray" onClick={() => void removeBackground()}>
                      移除
                    </Button>
                  ) : null}
                </Group>
                <Text size="xs" c="dimmed">
                  图片只保存在这台浏览器里，不会上传到 Server。
                </Text>
              </Stack>
            </Group>
          </Box>

          {appearance.background ? (
            <Box maw={300}>
              <Text size="sm" fw={500} mb={6}>
                背景不透明度
              </Text>
              <Slider
                min={0}
                max={100}
                step={5}
                value={opacityDraft}
                onChange={setOpacityDraft}
                onChangeEnd={saveOpacity}
                label={(v: number) => `${v}%`}
              />
              <Text size="xs" c="dimmed" mt={4}>
                数值越低背景越淡，文字越容易读。
              </Text>
            </Box>
          ) : null}
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          选好来源后这里可以设置标题和背景。
        </Text>
      )}

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

      <Divider label="新标签页" labelPosition="left" />

      {/* Which artifact is installed is not visible from the icon and cannot be
          changed from inside the extension, so the page says it plainly rather
          than offering a toggle that would lie (§8.3). It is last because it is
          a fact about the packaging, not something set here. */}
      <Text size="sm" c="dimmed">
        {typeof __PONTIS_NEWTAB_BUILD__ !== 'undefined' && __PONTIS_NEWTAB_BUILD__
          ? '当前安装的是接管版本：新标签页会显示 Pontis 起始页。要恢复浏览器原来的新标签页，停用或卸载本扩展即可；扩展内没有这个开关。若新标签页仍是浏览器原来的样子，多半是浏览器在装入或更新时把它停用了——到扩展管理页点「启用」即可，每次更新后可能需要再点一次。'
          : '当前安装的是标准同步版本，不会接管新标签页。想让新标签页显示 Pontis 起始页，请另行安装「Pontis (起始页)」构建；停用本扩展不会影响浏览器原有的新标签页。'}
      </Text>
    </Stack>
  );
}
