import { useEffect, useMemo, useRef, useState } from 'react';
import { Text } from '@mantine/core';
import type { StartPageSnapshotNode } from '@pontis/api';
import { openWithTarget, safeHref } from '../../lib/safe-url';
import { searchSource, type SourceTree } from '../../features/start-page/tree';
import {
  dismissed,
  enterTarget,
  maySubmit,
  moveSelection,
  withQuery,
  type SearchSession,
} from '../../features/start-page/search-session';
import * as styles from '../../styles/start-page.css';

interface Props {
  tree: SourceTree;
  /** The folder the search is bounded by, shown so the scope is never a
   * guess (§7.3). */
  sourceTitle: string;
  spaceId: string;
  openTarget: 'current-tab' | 'new-tab';
  onNavigate: (folderId: string) => void;
}

/** Search inside the configured source.
 *
 * The scope is the whole source subtree, not the folder currently on screen:
 * a result list that changed depending on where the reader happened to drill
 * would not be searchable (§7.3). Nothing is sent anywhere — titles and
 * addresses are matched against the snapshot already in this browser.
 */
export default function StartPageSearch({ tree, sourceTitle, openTarget, onNavigate }: Props) {
  const [session, setSession] = useState<SearchSession>({ mode: 'bookmarks', query: '', composing: false, selected: -1 });
  const inputRef = useRef<HTMLInputElement>(null);
  const open = session.query.trim().length > 0;

  const hits = useMemo(() => (open ? searchSource(tree, session.query) : []), [tree, session.query, open]);

  // A refresh that removed the selected row must not leave Enter pointing at
  // whatever now occupies that index.
  useEffect(() => {
    if (session.selected >= hits.length) setSession((s) => ({ ...s, selected: -1 }));
  }, [hits.length, session.selected]);

  const activate = (node: StartPageSnapshotNode) => {
    if (node.type === 'folder') {
      onNavigate(node.id);
      setSession(dismissed(session));
      return;
    }
    // A bookmark that will not open safely stays a result: the reader can see
    // it matched and copy it from the workbench, which is what the grid does
    // too (§16.1).
    if (safeHref(node.url ?? '')) openWithTarget(node.url ?? '', openTarget);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSession((s) => moveSelection(s, 1, hits.length));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setSession((s) => moveSelection(s, -1, hits.length));
        return;
      case 'Escape':
        // Escape leaves the result state. It does not clear the browser's own
        // focus contract: the address bar still wins if that is where the
        // reader goes next (§7.4).
        event.preventDefault();
        setSession(dismissed(session));
        return;
      case 'Enter': {
        // An Enter that belongs to an input method's candidate list is not a
        // submission, and a bookmark search with nothing picked opens nothing.
        if (!maySubmit(session)) {
          event.preventDefault();
          return;
        }
        const target = enterTarget(session, hits);
        if (!target) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        activate(target.node);
        setSession(dismissed(session));
      }
    }
  };

  return (
    <div className={styles.searchWrap}>
      <div className={styles.searchBox}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls="start-page-search-results"
          aria-label="搜索来源内的书签"
          placeholder={`搜索「${sourceTitle}」内的书签`}
          value={session.query}
          onChange={(e) => setSession((s) => withQuery(s, e.target.value))}
          onKeyDown={onKeyDown}
          onCompositionStart={() => setSession((s) => ({ ...s, composing: true }))}
          onCompositionEnd={() => setSession((s) => ({ ...s, composing: false }))}
        />
      </div>

      {open ? (
        <ul className={styles.searchResults} id="start-page-search-results" role="listbox" aria-label="书签搜索结果">
          {hits.length === 0 ? (
            // No results is an answer, not a reason to change the subject: the
            // page does not quietly switch to a web search (§7.3).
            <li className={styles.searchEmpty}>
              <Text component="span" size="sm">
                「{sourceTitle}」里没有匹配的书签。
              </Text>
            </li>
          ) : (
            hits.map((hit, i) => (
              <li key={hit.node.id} role="option" aria-selected={session.selected === i}>
                <button
                  type="button"
                  className={styles.searchRow}
                  data-selected={session.selected === i}
                  onMouseEnter={() => setSession((s) => ({ ...s, selected: i }))}
                  onClick={() => {
                    activate(hit.node);
                    setSession(dismissed(session));
                  }}
                  title={hit.node.url ?? hit.node.title}
                >
                  <span className={styles.searchRowText}>
                    <span className={styles.searchRowTitle}>{hit.node.title}</span>
                    <span className={styles.searchRowPath}>
                      {hit.trail.length ? hit.trail.join(' / ') : hit.node.url ?? ''}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
