import { useEffect, useRef, useState } from 'react';
import { Text, ActionIcon, Skeleton } from '@mantine/core';
import {
  IconChevronRight,
  IconFolder,
  IconDots,
} from '@tabler/icons-react';
import { formatShortTime, extractHost } from '../../lib/format';
import type { ExplorerState, TreeIndex } from '../../features/explorer';
import {
  explorerContainer,
  explorerColumnHeader,
  explorerRow,
  explorerRowSelected,
  explorerRowFocused,
  explorerRowIcon,
  explorerRowTitle,
  explorerRowTitleFolder,
  explorerRowMeta,
  explorerRowTime,
  explorerRowActions,
  favicon,
} from '../../styles/explorer.css';
import { tokens } from '../../styles/semantic-tokens.css';

interface BookmarkExplorerProps {
  isLoading: boolean;
  index: TreeIndex;
  state: ExplorerState;
  renamingId: string | null;
  onStartRename: (id: string | null) => void;
  onCommitRename: (id: string, title: string) => void;
  onDeleteKey: () => void;
}

const INDENT_PX = 16;

export default function BookmarkExplorer({
  isLoading,
  index,
  state,
  renamingId,
  onStartRename,
  onCommitRename,
  onDeleteKey,
}: BookmarkExplorerProps) {
  const { rows, expanded, selected, focusId, toggleExpand, handleClick, handleKeyDown } = state;

  // Keep the keyboard cursor visible.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (focusId) {
      rowRefs.current.get(focusId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusId]);

  if (isLoading) {
    return (
      <div className={explorerContainer} style={{ padding: '16px' }}>
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} height={38} mb={2} />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: tokens.textSecondary,
        gap: '8px',
      }}>
        <IconFolder size={32} stroke={1.2} />
        <Text fz="sm">这个空间还是空的</Text>
        <Text fz="xs" c="dimmed">你可以从浏览器同步现有书签，或创建第一个书签。</Text>
      </div>
    );
  }

  return (
    <div
      className={explorerContainer}
      tabIndex={0}
      onKeyDown={(e) => {
        handleKeyDown(e);
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
          e.preventDefault();
          onDeleteKey();
        }
      }}
      role="listbox"
      aria-multiselectable
      aria-label="书签列表"
      style={{ outline: 'none' }}
    >
      {/* Column header */}
      <div className={explorerColumnHeader}>
        <span style={{ flex: 1 }}>名称</span>
        <span style={{ width: '200px' }}>链接</span>
        <span style={{ width: '60px', textAlign: 'right' }}>时间</span>
      </div>

      {/* Rows */}
      {rows.map(({ node, depth, childCount }) => {
        const isSelected = selected.has(node.id);
        const isFocused = node.id === focusId;
        const isExpanded = expanded.has(node.id);
        const isRenaming = renamingId === node.id;

        return (
          <div
            key={node.id}
            ref={(el) => {
              if (el) rowRefs.current.set(node.id, el);
              else rowRefs.current.delete(node.id);
            }}
            role="option"
            aria-selected={isSelected}
            className={[
              explorerRow,
              isSelected ? explorerRowSelected : '',
              isFocused ? explorerRowFocused : '',
            ].join(' ')}
            style={{ paddingLeft: 16 + depth * INDENT_PX }}
            onClick={(e) => {
              if (!isRenaming) handleClick(e, node.id);
            }}
            onDoubleClick={() => {
              if (node.type === 'folder') toggleExpand(node.id);
              else onStartRename(node.id);
            }}
          >
            {node.type === 'folder' ? (
              <>
                <IconChevronRight
                  size={14}
                  stroke={1.5}
                  className={explorerRowIcon}
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 100ms' }}
                  onClick={(e) => { e.stopPropagation(); toggleExpand(node.id); }}
                />
                <IconFolder size={16} stroke={1.5} className={explorerRowIcon} />
                {isRenaming ? (
                  <RenameInput
                    initial={node.title}
                    onCommit={(title) => onCommitRename(node.id, title)}
                    onCancel={() => onStartRename(null)}
                  />
                ) : (
                  <span className={`${explorerRowTitle} ${explorerRowTitleFolder}`}>{node.title}</span>
                )}
                <span style={{ width: '200px', flexShrink: 0 }} />
                <span className={explorerRowTime}>{childCount} 项</span>
              </>
            ) : (
              <>
                <span style={{ width: 22, flexShrink: 0 }} />
                <img
                  className={favicon}
                  src={`https://www.google.com/s2/favicons?domain=${extractHost(node.url ?? '')}&sz=16`}
                  alt=""
                />
                {isRenaming ? (
                  <RenameInput
                    initial={node.title}
                    onCommit={(title) => onCommitRename(node.id, title)}
                    onCancel={() => onStartRename(null)}
                  />
                ) : (
                  <span className={explorerRowTitle}>{node.title}</span>
                )}
                <span className={explorerRowMeta}>{extractHost(node.url ?? '')}</span>
                <span className={explorerRowTime}>{formatShortTime(node.updated_at)}</span>
              </>
            )}

            {/* Hover actions (menu wired in a later module) */}
            <span className={explorerRowActions}>
              <ActionIcon variant="subtle" size="xs" color="coolGray">
                <IconDots size={14} stroke={1.5} />
              </ActionIcon>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Inline rename field: Enter/blur commits, Escape cancels. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  const commit = () => {
    const title = value.trim();
    if (title && title !== initial) onCommit(title);
    else onCancel();
  };

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={commit}
      style={{
        flex: 1,
        minWidth: 0,
        height: '26px',
        fontSize: '14px',
        color: tokens.textPrimary,
        backgroundColor: tokens.workspaceBg,
        border: `1px solid ${tokens.accent}`,
        borderRadius: '4px',
        padding: '0 6px',
        outline: 'none',
      }}
    />
  );
}
