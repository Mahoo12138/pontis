// The search area of the start page: one box, two explicit modes.
//
// 网页 hands the text to the browser's own default provider through the
// adapter. 书签 matches against the snapshot already in this browser and never
// sends the words anywhere. The modes are separate controls because they have
// separate consequences, and a box that decided for the reader which one a
// string looked like would be the end of predictability (§7.1).

import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from '@mantine/core';
import { searchSource, type SourceTree } from '../../core/start-page/tree';
import { navigableUrl, openNavigable } from '../../core/start-page/url';
import type { SearchAdapter } from '../../core/start-page/search';
import {
  dismissed,
  enterTarget,
  idleSession,
  maySubmit,
  moveSelection,
  withMode,
  withQuery,
  type SearchMode,
  type SearchSession,
} from '../../core/start-page/search-session';
import type { StartPageSnapshotNodeWire } from '../../core/start-page/wire';

interface Props {
  tree: SourceTree;
  adapter: SearchAdapter;
  /** The mode this browser used last; remembered, never guessed per-string. */
  initialMode: SearchMode;
  sourceTitle: string;
  openTarget: 'current-tab' | 'new-tab';
  onModeChange: (mode: SearchMode) => void;
  onNavigate: (folderId: string) => void;
}

export function SearchArea({ tree, adapter, initialMode, sourceTitle, openTarget, onModeChange, onNavigate }: Props) {
  const [session, setSession] = useState<SearchSession>(idleSession(initialMode));
  const [notice, setNotice] = useState<string | null>(null);

  const trimmed = session.query.trim();
  const showingResults = trimmed.length > 0 && session.mode === 'bookmarks';
  const hits = useMemo(
    () => (showingResults ? searchSource(tree, trimmed) : []),
    [tree, trimmed, showingResults],
  );

  // A refresh that removed rows must not leave Enter pointing at whatever now
  // occupies the old index.
  useEffect(() => {
    if (session.selected >= hits.length) setSession((s) => ({ ...s, selected: -1 }));
  }, [hits.length, session.selected]);

  const activate = (node: StartPageSnapshotNodeWire) => {
    if (node.type === 'folder') {
      onNavigate(node.id);
      setSession(dismissed(session));
      return;
    }
    if (navigableUrl(node.url)) openNavigable(navigableUrl(node.url)!, openTarget);
  };

  const submitWeb = async () => {
    if (!adapter.canSearchWeb) {
      // Refuse in the open. Substituting an engine the reader never picked is
      // the failure this branch exists to avoid (§7.2).
      setNotice(adapter.unavailableReason);
      return;
    }
    setNotice(null);
    try {
      await adapter.searchWeb(trimmed);
    } catch {
      // The text stays where it is: a failed submission is retried by the
      // reader, not by this page in the background (§7.4).
      setNotice('搜索没有提交成功，可以再按一次回车。');
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (showingResults) setSession((s) => moveSelection(s, 1, hits.length));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (showingResults) setSession((s) => moveSelection(s, -1, hits.length));
        return;
      case 'Escape':
        event.preventDefault();
        setSession(dismissed(session));
        setNotice(null);
        return;
      case 'Enter': {
        if (!maySubmit(session)) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        if (session.mode === 'web') {
          void submitWeb();
          return;
        }
        const target = enterTarget(session, hits);
        // Nothing picked: do not guess a target.
        if (!target) return;
        activate(target.node);
        setSession(dismissed(session));
      }
    }
  };

  return (
    <Box className="pontis-spSearchWrap">
      <div className="pontis-spSearchBox">
        <button
          type="button"
          className="pontis-spModeSwitch"
          // The label is a control, not a caption: switching keeps the text and
          // submits nothing.
          onClick={() => {
            const next: SearchMode = session.mode === 'web' ? 'bookmarks' : 'web';
            setSession((s) => withMode(s, next));
            setNotice(null);
            onModeChange(next);
          }}
          title="切换网页搜索与书签搜索"
        >
          {session.mode === 'web' ? '网页' : '书签'}
        </button>
        <input
          className="pontis-spSearchInput"
          type="search"
          role="combobox"
          aria-expanded={showingResults}
          aria-controls="start-page-search-results"
          aria-label={session.mode === 'web' ? '网页搜索' : `搜索「${sourceTitle}」内的书签`}
          placeholder={
            session.mode === 'web' ? '搜索网页' : `搜索「${sourceTitle}」内的书签`
          }
          value={session.query}
          onChange={(e) => setSession((s) => withQuery(s, e.target.value))}
          onKeyDown={onKeyDown}
          onCompositionStart={() => setSession((s) => ({ ...s, composing: true }))}
          onCompositionEnd={() => setSession((s) => ({ ...s, composing: false }))}
        />
      </div>

      {notice ? (
        <Text className="pontis-spSearchNotice" size="xs">
          {notice}
        </Text>
      ) : null}

      {showingResults ? (
        <ul className="pontis-spResults" id="start-page-search-results" role="listbox" aria-label="书签搜索结果">
          {hits.length === 0 ? (
            // No results is an answer. The page does not fall through to a web
            // search the reader did not ask for (§7.3).
            <li className="pontis-spResultsEmpty">「{sourceTitle}」里没有匹配的书签。</li>
          ) : (
            hits.map((hit, i) => (
              <li key={hit.node.id} role="option" aria-selected={session.selected === i}>
                <button
                  type="button"
                  className="pontis-spResultRow"
                  data-selected={session.selected === i}
                  onMouseEnter={() => setSession((s) => ({ ...s, selected: i }))}
                  onClick={() => {
                    activate(hit.node);
                    setSession(dismissed(session));
                  }}
                  title={hit.node.url ?? hit.node.title}
                >
                  <span className="pontis-spResultText">
                    <span className="pontis-spResultTitle">{hit.node.title}</span>
                    <span className="pontis-spResultPath">
                      {hit.trail.length ? hit.trail.join(' / ') : hit.node.url ?? ''}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </Box>
  );
}
