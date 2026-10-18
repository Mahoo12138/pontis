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
  Badge,
  Box,
  Button,
  ColorInput,
  Group,
  Input,
  Modal,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { createRuntime, errText } from './runtime';
import { SectionHeading } from './Section';
import { chromeApi } from '../runtime/chromeApi';
import { FolderPickerField } from './FolderPickerField';
import { buildFolderTree, pathTitlesOf, type FolderTreeNode } from './folderTree';
import { clearStartPage, patchConfig, saveSource } from '../core/start-page/provider';
import {
  BACKGROUND_ERROR_TEXT,
  defaultAppearance,
  greetingFor,
  loadAppearance,
  prepareBackground,
  publishAppearanceChange,
  saveAppearance,
  tintsFromStoredBackground,
} from '../core/start-page/appearance';
import { LEGIBILITY_FLOOR, groundLegibility, normalizeTint } from '../core/start-page/tint';
import type { StartPageAppearanceRecord, StartPageConfigRecord } from '../core/store/db';

const runtime = createRuntime();
const deps = { db: runtime.db, bootstrap: runtime.bootstrap, client: runtime.client };

/** The picker's top row: the theme's own two grounds, so "back to no colour"
 * is a choice in the same control as the colours read out of a picture. */
const GROUND_SWATCHES = ['#ffffff', '#f8f9fa', '#e7e9ec', '#d1d5db', '#374151', '#202329', '#17191c', '#111315'];

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
  /** The tuning set is opened on demand; see 外观 below. */
  const [lookOpen, setLookOpen] = useState(false);
  /** So is the source picker: one card on the page says what is shown, the
   *  dialog is where the two choices are made. */
  const [sourceOpen, setSourceOpen] = useState(false);
  const [opacityDraft, setOpacityDraft] = useState(0);
  const [surfaceDraft, setSurfaceDraft] = useState(0);
  const [tintLightDraft, setTintLightDraft] = useState('');
  const [tintDarkDraft, setTintDarkDraft] = useState('');

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
    setSurfaceDraft(Math.round(look.surfaceOpacity * 100));
    setTintLightDraft(look.tintLight ?? '');
    setTintDarkDraft(look.tintDark ?? '');
  }, []);

  /** The two colour fields show what the row holds, in the one form they take. */
  const showTints = (row: StartPageAppearanceRecord) => {
    setTintLightDraft(row.tintLight ?? '');
    setTintDarkDraft(row.tintDark ?? '');
  };

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
      setSourceOpen(false);
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
    patch: Partial<
      Pick<
        StartPageAppearanceRecord,
        'titleText' | 'background' | 'backgroundOpacity' | 'surfaceOpacity' | 'tintLight' | 'tintDark'
      >
    >,
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
      // A new picture is a new colour: what was read out of the old one is
      // replaced rather than kept as a hand-tint over something else.
      const next = await applyAppearance({
        background: prepared.dataUrl,
        tintLight: prepared.tints?.light ?? null,
        tintDark: prepared.tints?.dark ?? null,
      });
      if (next) showTints(next);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const removeBackground = async () => {
    const next = await applyAppearance({ background: null });
    if (next) showTints(next);
  };

  const saveOpacity = (percent: number) => void applyAppearance({ backgroundOpacity: percent / 100 });

  const saveSurface = (percent: number) => void applyAppearance({ surfaceOpacity: percent / 100 });

  /** Take the colour back out of the wallpaper the page is already showing. */
  const reextractTints = async () => {
    if (!config || !appearance.background) return;
    setBusy('tint');
    setError(null);
    try {
      const tints = await tintsFromStoredBackground(appearance.background);
      const next = await applyAppearance({
        tintLight: tints?.light ?? null,
        tintDark: tints?.dark ?? null,
      });
      if (next) showTints(next);
      if (!tints) setError('这张图片看不出主色调，已改用主题底色。');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  // Typed, not picked, can be mid-edit: an unfinished hex keeps the stored
  // colour rather than quietly clearing it, and the field says why.
  const lightInvalid = tintLightDraft !== '' && normalizeTint(tintLightDraft) === null;
  const darkInvalid = tintDarkDraft !== '' && normalizeTint(tintDarkDraft) === null;

  const saveTints = async () => {
    if (!config) return;
    const light = lightInvalid ? appearance.tintLight : normalizeTint(tintLightDraft);
    const dark = darkInvalid ? appearance.tintDark : normalizeTint(tintDarkDraft);
    if (light === appearance.tintLight && dark === appearance.tintDark) {
      showTints(appearance);
      return;
    }
    const next = await applyAppearance({ tintLight: light, tintDark: dark });
    if (next) showTints(next);
  };

  // §0.6's floor, reported rather than enforced: a colour or a thinness chosen
  // on purpose stays chosen, but the page says what it costs the text on it.
  // Both are measured at the worst case the spec allows — a black photograph at
  // full opacity — so the answer moves with the two sliders, not just the hues.
  const cover = Math.min(1, Math.max(0, surfaceDraft / 100));
  const illegible: string[] = [];
  for (const [label, typed, scheme] of [
    ['浅色配色', tintLightDraft, 'light'],
    ['深色配色', tintDarkDraft, 'dark'],
  ] as const) {
    const hex = normalizeTint(typed);
    if (hex && groundLegibility(hex, scheme, cover) < LEGIBILITY_FLOOR) illegible.push(label);
  }

  /** One line naming what the appearance currently is, so the page can keep the
   *  tuning out of sight without hiding its result. */
  const appearanceSummary = [
    appearance.titleText.trim() ? `标题「${appearance.titleText.trim()}」` : '标题按时间问候',
    appearance.background ? '已设壁纸' : '无壁纸',
    appearance.background
      ? `透 ${Math.round(appearance.backgroundOpacity * 100)}% / 底 ${Math.round(appearance.surfaceOpacity * 100)}%`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  /** Which of the two packages this copy is. The define exists only in a
   *  production build. */
  const newtabTakesOver = typeof __PONTIS_NEWTAB_BUILD__ !== 'undefined' && !!__PONTIS_NEWTAB_BUILD__;

  /** What the start page is showing, in words: a space id and a folder id next
   *  to the names the picker just offered read as a database dump and tell the
   *  reader nothing about where their bookmarks come from. */
  const sourceSpace = config ? (synced.find((s) => s.value === config.spaceId)?.label ?? config.spaceId) : '';
  const sourceFolder =
    config && config.spaceId === spaceId ? pathTitlesOf(tree, config.folderId)?.join(' / ') ?? '' : '';
  /** The card says what is shown, and when nothing is, which of the two reasons
   *  applies — a device with no bound space has nothing to choose yet. */
  const sourceLine = config
    ? [sourceSpace, sourceFolder].filter(Boolean).join(' / ')
    : synced.length === 0
      ? '这台设备还没有已同步的空间，先在「同步管理」里绑定一个。'
      : '还没有选择要显示的文件夹。';

  if (!paired) {
    return (
      <Alert color="accentBlue" variant="light" title="还没有配对">
        起始页显示的是这台设备已同步空间里的书签。请先在「账号管理」完成配对。
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      <Box className="pontis-listBox">
        <Box className="pontis-block">
          <Group justify="space-between" wrap="nowrap">
            <Box>
              <Text fw={600}>当前来源</Text>
              <Text size="sm" c="dimmed">
                {sourceLine}
              </Text>
              {config ? (
                <Text size="xs" c="dimmed" mt="xs">
                  更新于 {new Date(config.updatedAt).toLocaleString('zh-CN')}
                </Text>
              ) : null}
            </Box>
            <Group gap="xs" wrap="nowrap">
              {/* Stopping the display lives here, not under the picker: it acts on
                  the source that is set, which this block describes. Beside
                  设为来源 it read as the second half of one decision. */}
              {config ? (
                <Button size="xs" variant="subtle" color="coolGray" loading={busy === 'release'} onClick={() => void release()}>
                  停止显示
                </Button>
              ) : null}
              <Button
                variant={config ? 'default' : 'filled'}
                onClick={() => {
                  // Open clean: an error left over from the tree behind is not
                  // something this dialog did.
                  setError(null);
                  setSourceOpen(true);
                }}
              >
                {config ? '更改来源' : '选择来源'}
              </Button>
              <Button variant="light" component="a" href={chromeApi().runtime.getURL('start-page.html')} target="_blank">
                预览起始页
              </Button>
            </Group>
          </Group>
        </Box>
      </Box>

      {error ? (
        <Alert color="errorRed" variant="light" title="操作未完成">
          {error}
        </Alert>
      ) : null}

      {/* The two choices that decide what the page shows, opened from the card
          that reports the result. Flat on the page they kept a reader who had
          already chosen sitting in the middle of the same decision again, and
          pushed everything below it out of sight. */}
      <Modal opened={sourceOpen} onClose={() => setSourceOpen(false)} title="选择来源" size="lg" radius="lg">
        <Stack gap="md">
          {error ? (
            <Alert color="errorRed" variant="light" title="操作未完成">
              {error}
            </Alert>
          ) : null}
          <Text size="sm" c="dimmed">
            起始页显示哪个空间的哪个文件夹。这只是这台浏览器的显示决定，不影响同步。
          </Text>
          {synced.length === 0 ? (
            <Alert color="warningAmber" variant="light" title="这台设备还没有已同步的空间">
              起始页只显示这台浏览器已经同步的空间里的目录。请先在「同步管理」绑定一个空间并完成初始化。
            </Alert>
          ) : (
            <>
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
            </>
          )}
        </Stack>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setSourceOpen(false)}>
            取消
          </Button>
          <Button disabled={synced.length === 0 || !picked} loading={busy === 'save'} onClick={() => void save()}>
            设为来源
          </Button>
        </Group>
      </Modal>

      {/* Nothing below 当前来源 means anything until a source is set, so none of
          it renders: the page ends at the one action that is still available.
          The dialogs stay mounted regardless — closed they hold no layout, and
          the row that opens them is itself conditional. */}
      {config ? <SectionHeading title="外观" hint="起始页的标题、壁纸和底色。全部只作用于这台浏览器。" /> : null}

      {config ? (
        <Group justify="space-between" wrap="nowrap" className="pontis-spForm">
          <Stack gap="xs">
            <Text size="sm">{appearanceSummary}</Text>
            {illegible.length > 0 ? (
              <Text size="xs" c="warningAmber">
                当前底色上次要文字的可读性低于底线，进去调一下。
              </Text>
            ) : null}
          </Stack>
          <Button variant="default" size="compact-sm" onClick={() => setLookOpen(true)}>
            自定义外观
          </Button>
        </Group>
      ) : null}

      {/* The tuning set is opened on demand: six controls that are decided once
          were holding the page at the same weight as the one decision that
          matters here — which folder to display. */}
      <Modal
        opened={lookOpen}
        onClose={() => setLookOpen(false)}
        title="自定义外观"
        size="lg"
        radius="lg"
      >
        <Stack gap="md">
          <TextInput
            label="标题"
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

          {/* One row for the wallpaper and everything that only means something
              because a wallpaper does. The two layers hang under the picture —
              one step in, one step tighter than the groups beside them — so the
              page says which decisions depend on which. */}
          <Input.Wrapper
            label="背景图片"
            description="图片只保存在这台浏览器里，不会上传到 Server。"
          >
            <Group gap="sm" wrap="nowrap" align="center">
              {appearance.background ? (
                <img className="pontis-spBgThumb" src={appearance.background} alt="当前背景预览" />
              ) : (
                <Box className="pontis-spBgThumb pontis-spBgThumbEmpty" />
              )}
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
                  <Button size="xs" variant="subtle" color="coolGray" onClick={() => void removeBackground()}>
                    移除
                  </Button>
                ) : null}
              </Group>
            </Group>

            {appearance.background ? (
              <Box className="pontis-spNested pontis-spNestedWide">
                <SliderField
                  label="背景不透明度"
                  hint="壁纸透出来的量：越低越淡，文字越容易读。"
                  value={opacityDraft}
                  min={0}
                  step={5}
                  onChange={setOpacityDraft}
                  onChangeEnd={saveOpacity}
                />
                <SliderField
                  label="底面不透明度"
                  hint="标题栏、搜索框和每个磁贴上铺多少底色；四档之间保持原有的层次。"
                  value={surfaceDraft}
                  min={40}
                  step={1}
                  onChange={setSurfaceDraft}
                  onChangeEnd={saveSurface}
                />
                {/* The two colours the picture was read for, side by side because
                    they are one decision made twice — the same hue at the two ends
                    of the lightness scale — and a change to one is invisible in
                    the other. */}
                <Input.Wrapper
                  label="背景底色"
                  description="从图片的主色调算出，浅深各一档；可直接改，清空回到主题底色，移除图片后一并清除。"
                >
                  <Group gap="sm" align="flex-end">
                    <ColorInput
                      label="浅色配色"
                      maw={168}
                      format="hex"
                      withAsterisk={false}
                      swatches={GROUND_SWATCHES}
                      swatchesPerRow={8}
                      placeholder="主题底色"
                      value={tintLightDraft}
                      error={lightInvalid ? '请用 #rrggbb' : undefined}
                      onChange={setTintLightDraft}
                      onBlur={() => void saveTints()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void saveTints();
                        }
                      }}
                    />
                    <ColorInput
                      label="深色配色"
                      maw={168}
                      format="hex"
                      withAsterisk={false}
                      swatches={GROUND_SWATCHES}
                      swatchesPerRow={8}
                      placeholder="主题底色"
                      value={tintDarkDraft}
                      error={darkInvalid ? '请用 #rrggbb' : undefined}
                      onChange={setTintDarkDraft}
                      onBlur={() => void saveTints()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void saveTints();
                        }
                      }}
                    />
                    <Button size="xs" variant="light" loading={busy === 'tint'} onClick={() => void reextractTints()}>
                      按图片重新提取
                    </Button>
                  </Group>
                </Input.Wrapper>
                {illegible.length > 0 ? (
                  <Text size="xs" c="errorRed" mt="sm">
                  在这个底色与底面不透明度下，{illegible.join('、')}上的次要文字会低于 {LEGIBILITY_FLOOR}
                  :1 的可读底线。把底色调回接近白或接近黑，或把底面调浓一些。
                </Text>
              ) : null}
              </Box>
            ) : null}
          </Input.Wrapper>
        </Stack>
        <Group justify="flex-end" mt="md">
          <Button onClick={() => setLookOpen(false)}>完成</Button>
        </Group>
      </Modal>

      {config ? <SectionHeading title="显示" hint="点开书签和搜索结果时怎么打开，以及列表的松紧。" /> : null}

      {config ? (
        <Group grow className="pontis-spForm">
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

      <SectionHeading title="新标签页" hint="这个包装版本负不负责接管新标签页。它是安装的事实，不是这里能拨的开关。" />

      {/* State first, then what to do about it. The same facts used to arrive as
          one 130-character paragraph, so the reader had to parse the middle of a
          sentence to learn which case applied to them. */}
      {newtabTakesOver ? (
        <Stack gap="xs" className="pontis-spForm">
          <Group gap="xs" wrap="nowrap">
            <Badge color="healthyGreen" variant="light">
              已接管
            </Badge>
            <Text size="sm">新标签页显示 Pontis 起始页 · 停用或卸载本扩展即可换回</Text>
          </Group>
          <Text size="xs" c="dimmed">
            若新标签页仍是原来的样子：多半是浏览器在更新后停用了扩展，到扩展管理页点「启用」。
          </Text>
        </Stack>
      ) : (
        <Stack gap="xs" className="pontis-spForm">
          <Group gap="xs" wrap="nowrap">
            <Badge color="coolGray" variant="light">
              未接管
            </Badge>
            <Text size="sm">新标签页仍是浏览器自己的样子 · 想接管请安装「Pontis (起始页)」构建</Text>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

/**
 * A slider in the same shape as the fields around it: label, hint, control.
 *
 * The value it is set to goes in the label rather than only in the thumb,
 * because a thumb's position is not a readout — and because Mantine's Slider
 * has no label of its own, the floating one it does have disappears the moment
 * the pointer is let go.
 */
function SliderField({
  label,
  hint,
  value,
  min,
  step,
  onChange,
  onChangeEnd,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
  onChangeEnd: (value: number) => void;
}) {
  return (
    <Input.Wrapper
      labelElement="div"
      labelProps={{ className: 'pontis-spFieldLabelRow' }}
      label={
        <span className="pontis-spFieldLabel">
          <span>{label}</span>
          <span className="pontis-spFieldValue">{value}%</span>
        </span>
      }
      description={hint}
    >
      <Slider min={min} max={100} step={step} value={value} onChange={onChange} onChangeEnd={onChangeEnd} />
    </Input.Wrapper>
  );
}
