// The selection decisions of the explorer list, as pure functions.
//
// These live apart from `useExplorerState` because the bug they encode is about
// a rule, not about React: which presses replace the selection and which extend
// it, and what is allowed to make an id leave the selection. Testing the rule
// directly keeps it honest without a DOM.

/** The modifier state a press carries; pointer and mouse events both do. */
export interface PressModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface PressOutcome {
  selected: Set<string>;
  anchorId: string;
  /**
   * What a plain press replaced. A double-click always starts with one, and
   * drilling into a folder should not cost the batch that was being assembled,
   * so the caller can put this back.
   */
  replaced: Set<string>;
}

/** Shift+press selects the visible rows between the anchor and `id`. */
export function rangeTo(rowIds: string[], fromId: string, toId: string): Set<string> {
  const from = rowIds.indexOf(fromId);
  const to = rowIds.indexOf(toId);
  if (from === -1 || to === -1) return new Set([toId]);
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return new Set(rowIds.slice(lo, hi + 1));
}

export function pressSelection(
  prev: Set<string>,
  id: string,
  mods: PressModifiers,
  anchorId: string | null,
  rowIds: string[],
): PressOutcome {
  if (mods.shiftKey && anchorId) {
    return { selected: rangeTo(rowIds, anchorId, id), anchorId, replaced: prev };
  }
  if (mods.metaKey || mods.ctrlKey) {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchorId: id, replaced: prev };
  }
  return { selected: new Set([id]), anchorId: id, replaced: prev };
}

/**
 * Whether a plain press should record what it replaced. The second click of a
 * double-click lands on the row the first click already isolated, and
 * re-recording there would store the collapsed selection instead of the batch —
 * which is exactly the case the restore exists for.
 */
export function shouldRecordPress(prev: Set<string>, id: string): boolean {
  return !(prev.size === 1 && prev.has(id));
}

/**
 * Undo the plain press that precedes a double-click, when `id` was already part
 * of a multi-selection: the row stays selected and everything else comes back.
 */
export function keepThroughPress(replaced: Set<string>, id: string): Set<string> | null {
  if (replaced.size < 2 || !replaced.has(id)) return null;
  return new Set(replaced);
}

/**
 * The smallest set of deletes whose cascade covers the whole selection. The
 * server removes a folder's subtree with the folder, so also sending a
 * descendant makes the second call fail on a node that is already gone — and
 * because the deletes run in order, that aborts the rest of the batch.
 */
export function deleteTargets(selected: Set<string>, parentOf: (id: string) => string | null): string[] {
  const kept: string[] = [];
  for (const id of selected) {
    let covered = false;
    const walked = new Set([id]);
    for (let cur = parentOf(id); cur && !walked.has(cur); cur = parentOf(cur)) {
      walked.add(cur);
      if (selected.has(cur)) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(id);
  }
  return kept;
}

/**
 * Only a node that no longer exists leaves the selection. A row that merely
 * went off-screen — a collapsed ancestor, or the 文件夹/书签 filter hiding the
 * other type — keeps its place, because reaching a nested row has to happen
 * through the expansion or filter that hides everything else.
 */
export function pruneSelection(prev: Set<string>, exists: (id: string) => boolean): Set<string> {
  if (prev.size === 0) return prev;
  const kept = [...prev].filter(exists);
  return kept.length === prev.size ? prev : new Set(kept);
}
