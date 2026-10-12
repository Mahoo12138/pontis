import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Group, Stack, Text } from '@mantine/core';
import { ApiError } from '@pontis/api';
import { useMe } from '../hooks/use-auth';
import { useMeta } from '../hooks/use-meta';
import { useStartPageSnapshot } from '../hooks/use-start-page';
import StartPageLayout from '../components/start-page/StartPageLayout';
import BookmarkGrid from '../components/start-page/BookmarkGrid';
import StartPageSettings from '../components/start-page/StartPageSettings';
import { buildSourceTree, resolveCurrentFolder } from '../features/start-page/tree';
import { loadConfig, saveConfig, type StartPageConfig } from '../features/start-page/config';
import { formatRelativeTime } from '../lib/format';
import * as styles from '../styles/start-page.css';

/** The reason a snapshot did not arrive, in the page's own words.
 *
 * Each case gets its sentence because the action differs: a deleted source
 * needs a new choice, a lapsed authorization needs the account to approve
 * again, and a folder that is simply too large needs a smaller one. Collapsing
 * them into "加载失败" would leave the reader guessing which of the three is
 * being asked for (§15). */
function describeFailure(error: unknown): { headline: string; detail: string; strong: boolean } {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'START_PAGE_SOURCE_UNAVAILABLE':
        return {
          headline: '来源文件夹已经不在了',
          detail: '它可能被删除了，也可能被移到了别的位置。起始页不会退回整个空间来代替它。',
          strong: true,
        };
      case 'START_PAGE_PERMISSION_REQUIRED':
        return {
          headline: '这个来源读不了了',
          detail: '内容已停止显示。重新确认来源后才能继续。',
          strong: true,
        };
      case 'START_PAGE_SOURCE_TOO_LARGE':
        return {
          headline: '这个文件夹比起始页能读取的范围大',
          detail: '请换一个更小的文件夹。被省略的部分不会被当作完整结果展示。',
          strong: false,
        };
      default:
        break;
    }
  }
  return {
    headline: '未能读取书签',
    detail: 'Server 没有返回这个目录的内容。书签本身没有被改动，可以再试一次。',
    strong: false,
  };
}

export default function StartPage() {
  const me = useMe();
  const meta = useMeta();
  const userId = me.data?.id ?? '';
  const instanceId = meta.data?.instance_id ?? '';

  const [config, setConfig] = useState<StartPageConfig | null>(null);
  const [params, setParams] = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A folder that left the source during a refresh: the reader is told once,
  // in the page's own voice, rather than finding the level changed silently.
  const [movedBack, setMovedBack] = useState<string | null>(null);

  const source = config?.source ?? null;
  const spaceId = source?.spaceId;
  const folderParam = params.get('folder');
  const currentFolder = folderParam && source && folderParam !== source.folderId
    ? folderParam
    : source?.folderId;

  useEffect(() => {
    if (!userId) return;
    // Read at the moment the visitor is known, and never re-read a previous
    // account's value: this is the only line between two people's folders on
    // one browser profile (SP-26).
    setConfig(loadConfig(userId, instanceId));
  }, [userId, instanceId]);

  const snapshot = useStartPageSnapshot(spaceId, source?.folderId);

  const tree = useMemo(() => (snapshot.data ? buildSourceTree(snapshot.data) : null), [snapshot.data]);

  // Where the reader should be after a refresh: a drill-down position still
  // inside the source is kept, and one that left it comes back to the source
  // (§6.5). The source itself vanishing is the server's answer to report, not
  // something to paper over here.
  useEffect(() => {
    if (!tree || !currentFolder) return;
    const resolved = resolveCurrentFolder(tree, currentFolder);
    if (resolved.id !== currentFolder) {
      setMovedBack(tree.byId.get(currentFolder)?.title ?? tree.sourceTitle);
      setParams(resolved.id === tree.sourceId ? {} : { folder: resolved.id });
    }
  }, [tree, currentFolder, setParams]);

  const patch = useCallback(
    (next: Partial<StartPageConfig>) => {
      if (!userId) return;
      setConfig(saveConfig(userId, instanceId, next));
    },
    [userId, instanceId],
  );

  const chooseSource = useCallback(
    (chosen: { spaceId: string; folderId: string }) => {
      // Choosing a source and dropping the old drill-down happen together: the
      // previous folder id belongs to a different tree, and keeping it in the
      // URL would ask the page to show a folder it was never pointed at.
      setParams({});
      setMovedBack(null);
      patch({ source: { spaceId: chosen.spaceId, folderId: chosen.folderId } });
      setSettingsOpen(false);
    },
    [patch, setParams],
  );

  const navigate = useCallback(
    (folderId: string) => {
      if (!source || folderId === source.folderId) {
        setParams({});
        return;
      }
      setParams({ folder: folderId });
    },
    [source, setParams],
  );

  const settings = (
    <StartPageSettings
      opened={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      config={config ?? loadConfig('', instanceId)}
      onSelect={chooseSource}
      onClear={() => patch({ source: null })}
      onPatch={patch}
    />
  );

  const openSettings = () => setSettingsOpen(true);

  // No visitor yet, or no folder chosen yet: neither is a failure, and neither
  // has anything private to show.
  if (!userId || !config) {
    return (
      <>
        <StartPageLayout onConfigure={openSettings}>
          {!userId || !meta.data ? <SkeletonGrid /> : <NotConfigured onConfigure={openSettings} />}
        </StartPageLayout>
        {settings}
      </>
    );
  }

  if (!config.source) {
    return (
      <>
        <StartPageLayout onConfigure={openSettings}>
          <NotConfigured onConfigure={openSettings} />
        </StartPageLayout>
        {settings}
      </>
    );
  }

  if (snapshot.isError) {
    const failure = describeFailure(snapshot.error);
    return (
      <>
        <StartPageLayout onConfigure={openSettings}>
          <div className={styles.centeredState}>
            <div className={`${styles.notice} ${failure.strong ? styles.noticeStrong : ''}`}>
              <Text fz="sm" fw={failure.strong ? 600 : 400}>
                {failure.headline}
              </Text>
              <Text fz="xs" c="dimmed" mt={4}>
                {failure.detail}
              </Text>
            </div>
            <Group gap="xs">
              <Button size="xs" variant="light" onClick={() => void snapshot.refetch()}>
                重试
              </Button>
              <Button size="xs" variant="default" onClick={openSettings}>
                重新选择来源
              </Button>
            </Group>
          </div>
        </StartPageLayout>
        {settings}
      </>
    );
  }

  if (!snapshot.data || !tree || !spaceId) {
    return (
      <>
        <StartPageLayout onConfigure={openSettings}>
          <SkeletonGrid />
        </StartPageLayout>
        {settings}
      </>
    );
  }

  return (
    <>
      <StartPageLayout
        onConfigure={openSettings}
        status={
          <Group gap="sm" wrap="nowrap" justify="flex-end">
            {movedBack ? (
              <Text
                component="span"
                className={styles.notice}
                fz="xs"
                c="dimmed"
                onClick={() => setMovedBack(null)}
              >
                「{movedBack}」已不在来源内，已返回来源
              </Text>
            ) : null}
            <Text component="span" fz="xs" c="dimmed">
              内容已更新 · {formatRelativeTime(snapshot.data.snapshot.captured_at)}
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              loading={snapshot.isFetching}
              onClick={() => void snapshot.refetch()}
            >
              刷新
            </Button>
          </Group>
        }
      >
        <BookmarkGrid
          tree={tree}
          folderId={currentFolder ?? tree.sourceId}
          spaceId={spaceId}
          openTarget={config.openTarget}
          compact={config.density === 'compact'}
          onNavigate={navigate}
        />
      </StartPageLayout>
      {settings}
    </>
  );
}

function NotConfigured({ onConfigure }: { onConfigure: () => void }) {
  return (
    <div className={styles.centeredState}>
      <Stack gap={6}>
        <Text fz="sm">起始页显示工作台里已有的书签，不是另一套收藏。</Text>
        <Text fz="xs" c="dimmed">
          选择一个文件夹作为来源；之后在工作台里的改动会照原样出现在这里。
        </Text>
      </Stack>
      <Button onClick={onConfigure}>选择来源文件夹</Button>
    </div>
  );
}

/** First load with nothing to show yet. The grid's shape is kept so the
 * arriving content does not read as the page changing underneath the reader. */
function SkeletonGrid() {
  return (
    <div className={styles.grid} role="presentation" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={styles.skeleton} />
      ))}
    </div>
  );
}
