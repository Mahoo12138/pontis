import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Text, ActionIcon, Skeleton } from '@mantine/core';
import {
  IconChevronRight,
  IconFolder,
  IconDots,
} from '@tabler/icons-react';
import type { Node } from '@pontis/api';
import { formatShortTime, extractHost } from '../../lib/format';
import type { ExplorerState, TreeIndex } from '../../features/explorer';
import { isDragStart, rowsInMarquee } from '../../features/explorer';
import type { MarqueeRect, RowBand } from '../../features/explorer';
import {
  explorerContainer,
  explorerContainerRing,
  explorerColumnHeader,
  explorerMarquee,
  explorerSelectionHint,
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
  /** Details panel is up: Escape closes it instead of clearing the selection. */
  inspectorOpen: boolean;
  onCloseInspector: () => void;
  onStartRename: (id: string | null) => void;
  onCommitRename: (id: string, title: string) => void;
  onDeleteKey: () => void;
  onContextMenu: (clientX: number, clientY: number, id: string) => void;
  onOpenDetails: (node: Node) => void;
}

const INDENT_PX = 16;

export default function BookmarkExplorer({
  isLoading,
  state,
  renamingId,
  inspectorOpen,
  onCloseInspector,
  onStartRename,
  onCommitRename,
  onDeleteKey,
  onContextMenu,
  onOpenDetails,
}: BookmarkExplorerProps) {
  const { rows, expanded, selected, focusId, toggleExpand, press, selectRows, handleKeyDown, clearSelection } = state;

  // Keep the keyboard cursor visible.
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (focusId) {
      rowRefs.current.get(focusId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusId]);

  // The sweep rectangle lives here; the rows it covers are measured from the
  // DOM on every move, so a wheel scroll mid-drag stays accurate.
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);

  // Keyboard-arrival ring, decided by us: see explorerContainerRing.
  const [ring, setRing] = useState(false);
  const pressedByPointer = useRef(false);

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

  const measureRows = (): RowBand[] => {
    const bands: RowBand[] = [];
    for (const { node } of rows) {
      const el = rowRefs.current.get(node.id);
      if (!el) continue;
      const box = el.getBoundingClientRect();
      bands.push({ id: node.id, top: box.top, bottom: box.bottom, left: box.left, right: box.right });
    }
    return bands;
  };

  // The menu key has no cursor position to answer from, so it opens the menu
  // under the row the keyboard is on.
  const openMenuForRow = (id: string) => {
    const el = rowRefs.current.get(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    onContextMenu(r.left + 16, r.bottom, id);
  };

  /**
   * Press handling, Windows-Explorer style: the row under the pointer is
   * selected on mouse-down, and dragging from there (or from blank space)
   * sweeps a rubber-band over the rows it touches. Modifier presses keep
   * their usual meaning and never start a sweep.
   */
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    pressedByPointer.current = true;
    // The list may already hold focus, in which case no focus event will
    // arrive to drop the ring: a press is the keyboard's cue to step back.
    setRing(false);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, [data-no-select]')) return;

    // The press owns focus from here: letting the browser focus the list makes
    // a shift+click read as keyboard focus (and paint the tab ring), and lets
    // it drag a native text selection across the rows.
    e.preventDefault();
    containerRef.current?.focus({ preventScroll: true });

    const id = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;

    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (id) press(e, id);
      return;
    }

    if (id) press(e, id);
    else clearSelection();

    const origin = { x: e.clientX, y: e.clientY };
    let sweeping = false;

    const onMove = (move: PointerEvent) => {
      if (!sweeping && !isDragStart(origin.x, origin.y, move.clientX, move.clientY)) return;
      sweeping = true;
      const rect: MarqueeRect = { x0: origin.x, y0: origin.y, x1: move.clientX, y1: move.clientY };
      setMarquee(rect);
      const bands = measureRows();
      const hits = rowsInMarquee(bands, rect);
      // The cursor row, not the last one in list order: a drag upwards should
      // leave the keyboard where the pointer is.
      const swept = new Set(hits);
      const under = bands.find((b) => swept.has(b.id) && b.top <= move.clientY && b.bottom > move.clientY);
      selectRows(hits, under?.id ?? hits[hits.length - 1]);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setMarquee(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={containerRef}
      className={[explorerContainer, ring ? explorerContainerRing : ''].join(' ')}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onFocus={() => setRing(!pressedByPointer.current)}
      onBlur={() => {
        setRing(false);
        pressedByPointer.current = false;
      }}
      onKeyDown={(e) => {
        // Bare modifiers ride along with a mouse gesture; real keys mean the
        // keyboard is driving the tree, so say so.
        if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) setRing(true);
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          if (focusId) openMenuForRow(focusId);
          return;
        }
        if (e.key === 'Escape' && inspectorOpen) {
          e.preventDefault();
          onCloseInspector();
          return;
        }
        // Renaming moved off double-click, which is now "open details".
        if (e.key === 'F2') {
          e.preventDefault();
          if (focusId) onStartRename(focusId);
          return;
        }
        handleKeyDown(e);
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
          e.preventDefault();
          onDeleteKey();
        }
      }}
      role="listbox"
      aria-multiselectable
      aria-label="书签列表"
    >
      {/* Column header */}
      <div className={explorerColumnHeader} data-no-select>
        <span style={{ flex: 1 }}>名称</span>
        <span style={{ width: '200px' }}>链接</span>
        <span style={{ width: '60px', textAlign: 'right' }}>时间</span>
        {selected.size > 1 && (
          <span className={explorerSelectionHint}>已选中 {selected.size} 项，右键可批量操作</span>
        )}
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
            data-node-id={node.id}
            role="option"
            aria-selected={isSelected}
            aria-level={depth + 1}
            {...(node.type === 'folder' ? { 'aria-expanded': isExpanded } : {})}
            className={[
              explorerRow,
              isSelected ? explorerRowSelected : '',
              isFocused ? explorerRowFocused : '',
            ].join(' ')}
            style={{ paddingLeft: 16 + depth * INDENT_PX }}
            onDoubleClick={() => {
              if (node.type === 'folder') toggleExpand(node.id);
              else if (!isRenaming) onOpenDetails(node);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selected.has(node.id)) press(e, node.id);
              onContextMenu(e.clientX, e.clientY, node.id);
            }}
          >
            {node.type === 'folder' ? (
              <>
                <IconChevronRight
                  size={14}
                  stroke={1.5}
                  data-no-select
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

            {/* Row menu. Out of the tab ring on purpose: the tree is one stop
                and its rows are moved between with the arrows — a stop per row
                would make reaching the bottom of a space 500 presses. The
                keyboard gets the same menu from the Menu key / Shift+F10. */}
            <span className={explorerRowActions}>
              <ActionIcon
                variant="subtle"
                size="xs"
                color="coolGray"
                tabIndex={-1}
                aria-label={`更多操作：${node.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // The dots menu acts on the selection, so it has to own the
                  // row first — a press on a button is not a press on a row.
                  if (!isSelected) press({ shiftKey: false, metaKey: false, ctrlKey: false }, node.id);
                  const r = e.currentTarget.getBoundingClientRect();
                  onContextMenu(r.left, r.bottom, node.id);
                }}
              >
                <IconDots size={14} stroke={1.5} />
              </ActionIcon>
            </span>
          </div>
        );
      })}

      {marquee && (
        <div
          className={explorerMarquee}
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
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
