import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { flattenVisible } from './tree';
import type { ExplorerFilter, ExplorerRow, TreeIndex } from './tree';
import { keepThroughPress, pressSelection, pruneSelection, rangeTo, shouldRecordPress } from './selection';
import type { PressModifiers } from './selection';
import { openUrlSafely } from '../../lib/safe-url';

export type { PressModifiers } from './selection';

/**
 * Finder/IDE-style list state: focus cursor, multi-selection with an
 * anchor for shift+click ranges, and folder expansion. Owns the
 * visible-row computation so expansion and rows never disagree.
 *
 * Click semantics:
 *  - plain click   → single select, becomes anchor + focus
 *  - ⌘/ctrl click  → toggle row in selection
 *  - shift click   → select anchor..row over visible rows
 *  - rubber-band   → selectRows replaces the selection with the swept rows
 *
 * Keyboard: ↑/↓ move focus (shift extends selection), → expands or
 * enters a folder, ← collapses or jumps to parent, Enter opens
 * (folder toggles, bookmark opens safely), F2 renames, Space toggles
 * selection, ⌘/ctrl+A selects all visible rows, Escape clears.
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

  // Selection is not scoped to what is currently on screen. Collapsing a folder
  // or switching the 文件夹/书签 filter must not quietly drop the nested rows a
  // person had already picked — that is what made "select a folder and the
  // bookmarks beside it, delete together" impossible, because assembling the
  // batch required walking through a row set that kept discarding the part of
  // it you had not left expanded. Only ids that no longer exist leave here.
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, (id) => index.byId.has(id)));
  }, [index]);

  // The keyboard cursor and the shift-range anchor *are* positions in the
  // visible list, so those follow the rows.
  useEffect(() => {
    const visible = new Set(rowIds);
    if (focusId && !visible.has(focusId)) setFocusId(null);
    if (anchorId && !visible.has(anchorId)) setAnchorId(null);
  }, [rowIds, focusId, anchorId]);

  /**
   * A plain press replaces the selection, and drilling into a folder always
   * begins with one (double-click fires a press first). Keep what it replaced
   * so the double-click can put it back.
   */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const replacedByPress = useRef<Set<string> | null>(null);

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

  const selectRange = useCallback((fromId: string, toId: string) => rangeTo(rowIds, fromId, toId), [rowIds]);

  const press = useCallback(
    (e: PressModifiers, id: string) => {
      const out = pressSelection(selectedRef.current, id, e, anchorId, rowIds);
      if (shouldRecordPress(selectedRef.current, id)) replacedByPress.current = out.replaced;
      setFocusId(id);
      setSelected(out.selected);
      setAnchorId(out.anchorId);
    },
    [anchorId, rowIds],
  );

  /**
   * Undo the selection a plain press replaced, when `id` was part of it. Called
   * from the double-click that drills into a folder: reaching a nested row
   * should not cost the batch that was already picked.
   */
  const keepSelectionThrough = useCallback((id: string) => {
    const replaced = replacedByPress.current;
    replacedByPress.current = null;
    if (!replaced) return;
    const restored = keepThroughPress(replaced, id);
    if (restored) setSelected(restored);
  }, []);

  /**
   * Rubber-band result: the swept rows become the whole selection.
   * `focus` parks the keyboard cursor on the row under the pointer so
   * shift/arrows continue from where the drag ended; an empty sweep clears.
   */
  const selectRows = useCallback((ids: string[], focus?: string) => {
    setSelected(new Set(ids));
    if (focus) {
      setFocusId(focus);
      setAnchorId(focus);
    }
  }, []);

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
    press,
    keepSelectionThrough,
    selectRows,
    handleKeyDown,
    clearSelection,
  };
}

export type ExplorerState = ReturnType<typeof useExplorerState>;
