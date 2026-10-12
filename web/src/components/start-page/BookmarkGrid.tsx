import { ActionIcon } from '@mantine/core';
import { IconChevronRight, IconCopy, IconExternalLink, IconFolder, IconWorld } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import type { StartPageSnapshotNode } from '@pontis/api';
import { classifyUrl, openWithTarget, safeHref } from '../../lib/safe-url';
import { extractHost } from '../../lib/format';
import type { SourceTree } from '../../features/start-page/tree';
import * as styles from '../../styles/start-page.css';

interface Props {
  tree: SourceTree;
  /** Where the reader is right now. A tab position, not a preference (§6.1). */
  folderId: string;
  spaceId: string;
  openTarget: 'current-tab' | 'new-tab';
  compact: boolean;
  onNavigate: (folderId: string) => void;
}

/** The current level of the source folder, and the way back.
 *
 * One level at a time: a start page that unfolded the whole subtree would be a
 * second tree to lay out, and the workbench already owns the first one (§6.1). */
export default function BookmarkGrid({ tree, folderId, spaceId, openTarget, compact, onNavigate }: Props) {
  const items = tree.childrenOf(folderId);
  const current = tree.byId.get(folderId);
  // pathOf already ends at the source, so the folder being looked at is only
  // appended when it is somewhere below it — otherwise the source would be
  // listed twice, once as "where you are" and once as "where you started".
  const crumbs =
    current && folderId !== tree.sourceId ? [...tree.pathOf(folderId), current] : tree.pathOf(folderId);

  return (
    <>
      <nav className={styles.breadcrumb} aria-label="目录位置">
        {crumbs.map((node, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={node.id} className={styles.crumbGroup}>
              {i > 0 ? <IconChevronRight size={12} aria-hidden /> : null}
              {/* The last crumb is where the reader already is, so it is not a
                  way to get there: a button that reloads the current level is a
                  control that does nothing. */}
              {last ? (
                <span className={`${styles.crumb} ${styles.crumbCurrent}`} aria-current="page" title={node.title}>
                  {node.title}
                </span>
              ) : (
                <button type="button" className={styles.crumb} onClick={() => onNavigate(node.id)} title={node.title}>
                  {node.title}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      {items.length === 0 ? (
        <div className={styles.centeredState}>
          <IconFolder size={28} aria-hidden />
          <span>这个文件夹还没有内容。</span>
          <Link to={`/spaces/${spaceId}`} className={styles.quietAction}>
            <IconExternalLink size={14} aria-hidden /> 在工作台管理这个目录
          </Link>
        </div>
      ) : (
        <ul className={`${styles.grid} ${compact ? styles.gridCompact : ''}`}>
          {items.map((node) => (
            <li key={node.id} className={styles.gridItem}>
              <Entry
                node={node}
                spaceId={spaceId}
                openTarget={openTarget}
                compact={compact}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Entry({
  node,
  spaceId,
  openTarget,
  compact,
  onNavigate,
}: {
  node: StartPageSnapshotNode;
  spaceId: string;
  openTarget: 'current-tab' | 'new-tab';
  compact: boolean;
  onNavigate: (folderId: string) => void;
}) {
  const card = `${styles.entry} ${compact ? styles.entryCompact : ''}`;

  if (node.type === 'folder') {
    return (
      <button type="button" className={card} onClick={() => onNavigate(node.id)} title={node.title}>
        <span className={styles.entryIcon} aria-hidden>
          <IconFolder size={20} />
        </span>
        <span className={styles.entryText}>
          {/* The whole title stays reachable even when the line is clipped: a
              truncated label must not be all the reader has to go on (§6.3). */}
          <span className={styles.entryTitle}>{node.title}</span>
          <span className={styles.entryMeta}>{node.child_count ? `${node.child_count} 项` : '空文件夹'}</span>
        </span>
      </button>
    );
  }

  const href = safeHref(node.url ?? '');

  // An http(s) bookmark is an ordinary anchor. The browser keeps its own
  // middle-click and modifier behaviour; only a plain activation is routed
  // through the configured target (§8.1, SP-20).
  if (href) {
    return (
      <a
        className={card}
        href={href}
        title={node.title}
        target={openTarget === 'new-tab' ? '_blank' : undefined}
        rel={openTarget === 'new-tab' ? 'noopener noreferrer' : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          openWithTarget(node.url ?? '', openTarget);
        }}
      >
        <span className={styles.entryIcon} aria-hidden>
          {/* A neutral mark, deliberately not fetched: asking a favicon service
              about every bookmark would tell a third party where the reader is
              headed before they have gone anywhere (§16.2). */}
          <IconWorld size={18} />
        </span>
        <span className={styles.entryText}>
          <span className={styles.entryTitle}>{node.title}</span>
          <span className={styles.entryMeta}>{extractHost(node.url ?? '')}</span>
        </span>
      </a>
    );
  }

  // A bookmarklet, a file:, or an address the parser refused stays on the page
  // as text with a copy action. Nothing here executes it (§16.1).
  const kind = classifyUrl(node.url ?? '');
  return (
    <div className={card} title={node.title}>
      <span className={styles.entryIcon} aria-hidden>
        <IconWorld size={18} />
      </span>
      <span className={styles.entryText}>
        <span className={styles.entryTitle}>{node.title}</span>
        {/* Short enough to survive the column width: the reason this row is
            not openable is the one thing the meta line exists to say. */}
        <span className={styles.entryMeta} title={node.url ?? ''}>
          {kind === 'bookmarklet' ? 'Bookmarklet' : '仅可复制'}
        </span>
      </span>
      <span className={styles.entryActions}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="xs"
          aria-label="复制地址"
          title="复制地址"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(node.url ?? '')
              .then(() => notifications.show({ message: '已复制地址', withCloseButton: false }))
              .catch(() =>
                notifications.show({ message: '无法访问剪贴板', color: 'red', withCloseButton: false }),
              );
          }}
        >
          <IconCopy size={14} />
        </ActionIcon>
        <ActionIcon
          component={Link}
          to={`/spaces/${spaceId}`}
          variant="subtle"
          color="gray"
          size="xs"
          aria-label="在工作台管理这个书签"
          title="在工作台管理这个书签"
        >
          <IconExternalLink size={14} />
        </ActionIcon>
      </span>
    </div>
  );
}
