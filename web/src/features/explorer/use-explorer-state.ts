import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { flattenVisible } from './tree';
import type { ExplorerFilter, ExplorerRow, TreeIndex } from './tree';
import { openUrlSafely } from '../../lib/safe-url';

/**
 * Finder/IDE-style list state: focus cursor, multi-selection with an
 * anchor for shift+click ranges, and folder expansion. Owns the
 * visible-row computation so expansion and rows never disagree.
 *
 * Click semantics:
 *  - plain click   → single select, becomes anchor + focus
 *  - ⌘/ctrl click  → toggle row in selection
 *  - shift click   → select anchor..row over visible rows
 *
 * Keyboard: ↑/↓ move focus (shift extends selection), → expands or
 * enters a folder, ← collapses or jumps to parent, Enter opens
 * (folder toggles, bookmark opens safely), Space toggles selection,
 * ⌘/ctrl+A selects all visible rows, Escape clears.
 */
export function useExplorerState(index: TreeIndex, filter: ExplorerFilter) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const rows: ExplorerRow[] = useMemo(
    () => flattenVisible(index, expanded, filter),
    [index, expanded, filter],
  );
  const rowIds = useMemo(() => rows.map((r) => r.node.id), [rows]);

  // Drop stale ids when the row set changes (filter switch, deletes).
  useEffect(() => {
    const visible = new Set(rowIds);
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
    if (focusId && !visible.has(focusId)) setFocusId(null);
    if (anchorId && !visible.has(anchorId)) setAnchorId(null);
  }, [rowIds, focusId, anchorId]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapse = useCallback((id: string) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const expand = useCallback((id: string) => {
    setExpanded((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const selectRange = useCallback(
    (fromId: string, toId: string) => {
      const from = rowIds.indexOf(fromId);
      const to = rowIds.indexOf(toId);
      if (from === -1 || to === -1) return new Set([toId]);
      const [lo, hi] = from < to ? [from, to] : [to, from];
      return new Set(rowIds.slice(lo, hi + 1));
    },
    [rowIds],
  );

  const handleClick = useCallback(
    (e: MouseEvent, id: string) => {
      setFocusId(id);
      if (e.shiftKey && anchorId) {
        setSelected(selectRange(anchorId, id));
      } else if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setAnchorId(id);
      } else {
        setSelected(new Set([id]));
        setAnchorId(id);
      }
    },
    [anchorId, selectRange],
  );

  const focusRow = useCallback(
    (id: string, opts: { extend?: boolean } = {}) => {
      setFocusId(id);
      if (opts.extend && anchorId) {
        setSelected(selectRange(anchorId, id));
      } else {
        setSelected(new Set([id]));
        setAnchorId(id);
      }
    },
    [anchorId, selectRange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const focusIndex = focusId ? rowIds.indexOf(focusId) : -1;

      const move = (delta: number) => {
        const target = rowIds[Math.min(Math.max(focusIndex + delta, 0), rowIds.length - 1)];
        if (target) focusRow(target, { extend: e.shiftKey });
      };

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          if (focusIndex === -1) {
            if (rowIds[0]) focusRow(rowIds[0], { extend: e.shiftKey });
          } else {
            move(e.key === 'ArrowDown' ? 1 : -1);
          }
          break;
        }

        case 'ArrowRight': {
          const node = focusId ? index.byId.get(focusId) : undefined;
          if (!node || node.type !== 'folder') break;
          if (!expanded.has(node.id)) toggleExpand(node.id);
          else {
            const first = index.childrenOf(node.id)[0];
            if (first) focusRow(first.id, { extend: e.shiftKey });
          }
          break;
        }

        case 'ArrowLeft': {
          const node = focusId ? index.byId.get(focusId) : undefined;
          if (!node) break;
          if (node.type === 'folder' && expanded.has(node.id)) collapse(node.id);
          else {
            const parent = index.parentOf.get(node.id);
            if (parent) focusRow(parent.id, { extend: e.shiftKey });
          }
          break;
        }

        case 'Home':
          if (rowIds[0]) focusRow(rowIds[0], { extend: e.shiftKey });
          break;

        case 'End': {
          const last = rowIds[rowIds.length - 1];
          if (last) focusRow(last, { extend: e.shiftKey });
          break;
        }

        case 'Enter': {
          const node = focusId ? index.byId.get(focusId) : undefined;
          if (!node) break;
          if (node.type === 'folder') toggleExpand(node.id);
          else if (node.url) openUrlSafely(node.url);
          break;
        }

        case ' ': {
          e.preventDefault();
          const id = focusId ?? rowIds[0];
          if (!id) break;
          setFocusId(id);
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
          break;
        }

        case 'a':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            setSelected(new Set(rowIds));
          }
          break;

        case 'Escape':
          setSelected(new Set());
          break;

        default:
          break;
      }
    },
    [focusId, rowIds, index, expanded, toggleExpand, collapse, focusRow],
  );

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  return {
    rows,
    expanded,
    selected,
    focusId,
    toggleExpand,
    collapse,
    expand,
    focusRow,
    handleClick,
    handleKeyDown,
    clearSelection,
  };
}

export type ExplorerState = ReturnType<typeof useExplorerState>;
