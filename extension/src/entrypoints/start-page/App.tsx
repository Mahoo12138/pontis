// The extension's start page: a read-only view of one approved folder.
//
// It opens from the popup or the settings tab. Owning the browser's new tab is
// a separate, opt-in decision this build does not make (§9.2), which is why the
// entrypoint is a plain page rather than a `newtab` entrypoint.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { chromeApi } from '../../runtime/chromeApi';
import { createRuntime, errText } from '../../ui/runtime';
import {
  REVALIDATE_AFTER_MS,
  loadStartPage,
  patchConfig,
  refreshStartPage,
  type StartPageView,
} from '../../core/start-page/provider';
import { buildSourceTree, resolveCurrentFolder } from '../../core/start-page/tree';
import { navigableUrl, openNavigable, urlKind } from '../../core/start-page/url';
import { createSearchAdapter } from '../../core/start-page/search';
import { SearchArea } from './SearchArea';
import type { StartPageSnapshotNodeWire } from '../../core/start-page/wire';

const runtime = createRuntime();
const deps = { db: runtime.db, bootstrap: runtime.bootstrap, client: runtime.client };

/** Built once: whether this browser can do a default search does not change
 * while the page is open. */
const searchAdapter = createSearchAdapter(chromeApi().search);

/** How long a page that stays open waits before asking again (§14.2). A
 * courtesy interval, not the mechanism that keeps the view correct: the
 * revalidation on becoming visible, and the server's answer, do that. */
const VISIBLE_REFRESH_MS = 5 * 60 * 1000;

export function App() {
  const [view, setView] = useState<StartPageView | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Where this tab is. Deliberately not persisted: a new start page returns to
  // the configured source, and a drill-down is not a preference (§6.1).
  const [folderId, setFolderId] = useState('');
  const [movedBack, setMovedBack] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const snapshot = view?.snapshot ?? null;

  const apply = useCallback((next: StartPageView) => {
    setView(next);
    if (next.phase === 'ready' && next.snapshot) {
      setFolderId((current) => current || next.snapshot!.folderId);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The workbench deep link uses the paired server's own origin, read here
    // rather than taken from the cache: a server that moved should send the
    // reader to where it moved to, not to the origin recorded weeks ago (§6.4).
    void runtime.bootstrap.get().then((b) => setServerUrl(b.serverUrl ?? ''));
    void loadStartPage(deps).then((next) => {
      if (cancelled) return;
      apply(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    setFailure(null);
    try {
      const next = await refreshStartPage(deps);
      apply(next);
      if (next.phase !== 'ready' || !next.snapshot) return;
      // Keep the reader where they were, as long as that place still exists.
      const fresh = buildSourceTree({
        sourceId: next.snapshot.folderId,
        sourceTitle: next.snapshot.sourceTitle,
        nodes: next.snapshot.nodes,
      });
      const at = folderId || next.snapshot.folderId;
      const resolved = resolveCurrentFolder(fresh, at);
      if (resolved.lost) {
        setMovedBack(fresh.byId.get(at)?.title ?? null);
        setFolderId(resolved.id);
      }
    } catch (err) {
      setFailure(errText(err));
    } finally {
      setRefreshing(false);
    }
  }, [apply, folderId]);

  // Coming back to a tab that has been sitting: ask whether it is still
  // current (§14.2).
  useEffect(() => {
    const verifiedAt = snapshot?.verifiedAt;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (verifiedAt === undefined || Date.now() - verifiedAt >= REVALIDATE_AFTER_MS) void doRefresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void doRefresh();
    }, VISIBLE_REFRESH_MS);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [snapshot?.verifiedAt, doRefresh]);

  const tree = useMemo(
    () =>
      snapshot
        ? buildSourceTree({
            sourceId: snapshot.folderId,
            sourceTitle: snapshot.sourceTitle,
            nodes: snapshot.nodes,
          })
        : null,
    [snapshot],
  );

  const settingsHref = `${chromeApi().runtime.getURL('options.html')}#start-page`;

  if (loading) {
    return (
      <Shell>
        <Group justify="center" mt="xl">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            正在读取起始页内容……
          </Text>
        </Group>
      </Shell>
    );
  }

  const phase = view?.phase ?? 'unconfigured';

  if (phase === 'not-paired' || phase === 'unconfigured') {
    const unpaired = phase === 'not-paired';
    return (
      <Shell>
        <Emptyish
          icon={<FolderGlyph />}
          title={unpaired ? '还没有连接 Server' : '还没有选择要显示的文件夹'}
          body={
            unpaired
              ? '起始页显示的是 Pontis 里已有的书签。先完成配对，再选择一个来源文件夹。'
              : '选择一个来源后，这里显示的就是工作台里已有的书签，不需要再导入一次。'
          }
          action={
            <Button
              component="a"
              href={unpaired ? chromeApi().runtime.getURL('options.html') : settingsHref}
              target="_blank"
            >
              {unpaired ? '打开设置' : '配置起始页来源'}
            </Button>
          }
        />
      </Shell>
    );
  }

  if (phase !== 'ready' || !snapshot || !tree) {
    return (
      <Shell>
        <Refusal
          phase={phase}
          errorCode={view?.errorCode}
          detail={failure}
          onRetry={() => void doRefresh()}
          manage={
            <Button size="xs" variant="default" component="a" href={settingsHref} target="_blank">
              重新选择来源
            </Button>
          }
        />
      </Shell>
    );
  }

  const at = folderId && tree.contains(folderId) ? folderId : tree.sourceId;
  const current = tree.byId.get(at);
  const crumbs = at === tree.sourceId || !current ? tree.pathOf(at) : [...tree.pathOf(at), current];
  const items = tree.childrenOf(at);
  const openTarget = view?.config?.openTarget ?? 'current-tab';

  const goTo = (id: string) => {
    setMovedBack(null);
    setFolderId(id);
  };

  // The remembered mode is written back so the next new tab starts where this
  // reader left it, without that ever deciding what a typed string means.
  const patchSearchMode = async (mode: 'web' | 'bookmarks') => {
    const updated = await patchConfig(deps, { searchMode: mode });
    if (updated) setView((v) => (v ? { ...v, config: updated } : v));
  };

  return (
    <Shell
      status={
        <Group gap="sm" wrap="nowrap">
          {movedBack ? (
            <Text size="xs" c="dimmed" onClick={() => setMovedBack(null)}>
              「{movedBack}」已不在来源内，已返回来源
            </Text>
          ) : null}
          <Text size="xs" c="dimmed">
            {view?.fromCache ? '本地缓存 · ' : '内容已更新 · '}
            {relTime(snapshot.verifiedAt)}
          </Text>
          <Button size="compact-xs" variant="subtle" color="gray" loading={refreshing} onClick={() => void doRefresh()}>
            刷新
          </Button>
        </Group>
      }
    >
      <div className="pontis-spSearchArea">
        <SearchArea
          tree={tree}
          adapter={searchAdapter}
          initialMode={view?.config?.searchMode ?? 'web'}
          sourceTitle={tree.sourceTitle}
          openTarget={openTarget}
          onModeChange={(mode) => void patchSearchMode(mode)}
          onNavigate={goTo}
        />
      </div>

      <nav className="pontis-spCrumbs" aria-label="目录位置">
        {crumbs.map((node, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={node.id} className="pontis-spCrumbGroup">
              {i > 0 ? <span className="pontis-spSep" aria-hidden>›</span> : null}
              {last ? (
                <span className="pontis-spCrumb pontis-spCrumbNow" aria-current="page" title={node.title}>
                  {node.title}
                </span>
              ) : (
                <button type="button" className="pontis-spCrumb" onClick={() => setFolderId(node.id)} title={node.title}>
                  {node.title}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      {items.length === 0 ? (
        <Emptyish
          icon={<FolderGlyph />}
          title="这个文件夹还没有内容"
          body="在工作台里添加书签后，刷新这里就会看到。"
          action={
            <Button size="xs" variant="light" component="a" href={workbenchUrl(serverUrl, snapshot.spaceId)} target="_blank">
              在工作台管理
            </Button>
          }
        />
      ) : (
        <ul className="pontis-spGrid">
          {items.map((node) => (
            <li key={node.id}>
              <Entry node={node} openTarget={openTarget} onOpen={() => setFolderId(node.id)} />
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/** A controlled deep link into the workbench. No start-page credential rides
 * in it: the workbench asks for its own session (§6.4). */
function workbenchUrl(serverUrl: string, spaceId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/spaces/${spaceId}`;
}

function Shell({ children, status }: { children: React.ReactNode; status?: React.ReactNode }) {
  return (
    <Box className="pontis-page pontis-spShell">
      <Group justify="space-between" wrap="nowrap" className="pontis-spHead">
        <Title order={4} fw={600}>
          Pontis 起始页
        </Title>
        {status}
      </Group>
      <Box className="pontis-spBody">{children}</Box>
    </Box>
  );
}

/** The two marks that tell an entry's kind apart without relying on colour
 * (§6.3). Inline rather than an icon package: two paths do not justify adding
 * a dependency to the extension. */
function FolderGlyph() {
  return (
    <svg className="pontis-spEntryIcon" viewBox="0 0 24 24" width="20" height="20" aria-hidden focusable="false">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2c.5 0 .96.25 1.24.66L11 7h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function GlobeGlyph() {
  return (
    <svg className="pontis-spEntryIcon" viewBox="0 0 24 24" width="20" height="20" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M3.75 12h16.5M12 3.75c2.4 2.3 2.4 14.2 0 16.5M12 3.75c-2.4 2.3-2.4 14.2 0 16.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function Entry({
  node,
  openTarget,
  onOpen,
}: {
  node: StartPageSnapshotNodeWire;
  openTarget: 'current-tab' | 'new-tab';
  onOpen: () => void;
}) {
  if (node.type === 'folder') {
    return (
      <button type="button" className="pontis-spEntry" onClick={onOpen} title={node.title}>
        <FolderGlyph />
        <span className="pontis-spEntryText">
          <span className="pontis-spEntryTitle">{node.title}</span>
          <span className="pontis-spEntryMeta">{node.child_count ? `${node.child_count} 项` : '空文件夹'}</span>
        </span>
      </button>
    );
  }

  const open = navigableUrl(node.url);
  const kind = urlKind(node.url);
  const meta =
    kind === 'navigable' ? open?.host : kind === 'bookmarklet' ? 'Bookmarklet' : kind === 'other' ? '仅可复制' : '地址无法解析';

  if (open) {
    return (
      <a
        className="pontis-spEntry"
        href={open.href}
        title={node.title}
        target={openTarget === 'new-tab' ? '_blank' : undefined}
        rel={openTarget === 'new-tab' ? 'noopener noreferrer' : undefined}
        onClick={(event) => {
          // Only a plain left click is ours to route; the browser already knows
          // what a modifier click or a middle click means (§8.1).
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          openNavigable(open, openTarget);
        }}
      >
        <GlobeGlyph />
        <span className="pontis-spEntryText">
          <span className="pontis-spEntryTitle">{node.title}</span>
          <span className="pontis-spEntryMeta">{meta}</span>
        </span>
      </a>
    );
  }

  // A bookmarklet, a file:, an unparseable address: shown as text, never
  // executed and never navigated to from here (§16.1).
  return (
    <div className="pontis-spEntry" title={node.title}>
      <GlobeGlyph />
      <span className="pontis-spEntryText">
        <span className="pontis-spEntryTitle">{node.title}</span>
        <span className="pontis-spEntryMeta" title={node.url ?? ''}>
          {meta}
        </span>
      </span>
    </div>
  );
}

function Emptyish({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Stack align="center" gap="sm" mt="xl">
      {icon}
      <Title order={6}>{title}</Title>
      <Text size="sm" c="dimmed" ta="center" maw={420}>
        {body}
      </Text>
      {action}
    </Stack>
  );
}

/**
 * The ways a source can stop being showable, each with its own action.
 *
 * Not collapsed into one error card because what the reader can do differs:
 * pick another folder, approve again, choose a smaller folder, or check the
 * connection and try again (§15).
 */
function Refusal({
  phase,
  errorCode,
  detail,
  onRetry,
  manage,
}: {
  phase: string;
  errorCode?: string;
  detail: string | null;
  onRetry: () => void;
  manage: React.ReactNode;
}) {
  const copy =
    phase === 'source-unavailable'
      ? {
          title: '来源文件夹已经不在了',
          body: '它可能被删除了，也可能被移到了别的位置。起始页不会改用整个空间来代替它。',
          strong: true,
        }
      : phase === 'permission-required'
        ? { title: '这个来源读不了了', body: '内容已停止显示。重新确认来源后才能继续。', strong: true }
        : phase === 'source-too-large'
          ? {
              title: '这个文件夹比起始页能读取的范围大',
              body: '请换一个更小的文件夹；被省略的部分不会被当作完整结果展示。',
              strong: false,
            }
          : phase === 'offline'
            ? { title: '未能读取书签', body: 'Server 没有应答，本地也还没有这个目录的缓存。检查连接后重试。', strong: false }
            : { title: '返回的内容无法采用', body: '这一份快照没有被安装，之前的缓存仍然可用。', strong: false };

  return (
    <Stack gap="sm" mt="xl" maw={520}>
      <Alert color={copy.strong ? 'red' : 'amber'} variant="light" title={copy.title}>
        {copy.body}
        {errorCode ? (
          <Text component="div" size="xs" c="dimmed" mt={4}>
            {errorCode}
          </Text>
        ) : null}
        {detail ? (
          <Text component="div" size="xs" c="dimmed">
            {detail}
          </Text>
        ) : null}
      </Alert>
      <Group>
        <Button size="xs" variant="light" onClick={onRetry}>
          重试
        </Button>
        {manage}
      </Group>
    </Stack>
  );
}

function relTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
