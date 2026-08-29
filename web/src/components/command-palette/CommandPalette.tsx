import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Modal, TextInput } from '@mantine/core';
import {
  IconSearch,
  IconBookmark,
  IconFolderPlus,
  IconBookmarkPlus,
  IconMoon,
  IconSun,
  IconFolder,
  IconClock,
  IconDeviceDesktop,
  IconLayoutGrid,
} from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import { useSpaces } from '../../hooks/use-spaces';
import { useNodes } from '../../hooks/use-nodes';
import { extractHost } from '../../lib/format';
import { tokens } from '../../styles/semantic-tokens.css';

export const CREATE_NODE_EVENT = 'pontis:create-node';
export const OPEN_PALETTE_EVENT = 'pontis:open-palette';
export const FOCUS_NODE_EVENT = 'pontis:focus-node';

/**
 * Cross-space focus handoff: when the palette navigates to another space,
 * the target explorer mounts fresh and misses the FOCUS_NODE_EVENT fired
 * synchronously after navigate(). The target page consumes this instead.
 */
let pendingFocusId: string | null = null;

export function requestFocusNode(nodeId: string) {
  pendingFocusId = nodeId;
}

export function consumePendingFocus(): string | null {
  const id = pendingFocusId;
  pendingFocusId = null;
  return id;
}

interface PaletteItem {
  id: string;
  section: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  opened: boolean;
  onClose: () => void;
}

/** ⌘K command palette: actions, space switching, bookmark search. */
export default function CommandPalette({ opened, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const { data: spacesData } = useSpaces();

  const spaceMatch = location.pathname.match(/^\/spaces\/([^/]+)/);
  const currentSpaceId = spaceMatch?.[1];
  const { data: nodesData } = useNodes(currentSpaceId);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (opened) {
      setQuery('');
      setActive(0);
    }
  }, [opened]);

  const q = query.trim().toLowerCase();

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const spaces = spacesData?.spaces ?? [];
    const nodes = nodesData?.nodes ?? [];
    const onSpacePage = !!currentSpaceId;

    if (!q) {
      if (onSpacePage) {
        out.push(
          {
            id: 'act-new-bookmark',
            section: '操作',
            icon: <IconBookmarkPlus size={15} />,
            label: '新建书签',
            run: () => window.dispatchEvent(new CustomEvent(CREATE_NODE_EVENT, { detail: { mode: 'bookmark' } })),
          },
          {
            id: 'act-new-folder',
            section: '操作',
            icon: <IconFolderPlus size={15} />,
            label: '新建文件夹',
            run: () => window.dispatchEvent(new CustomEvent(CREATE_NODE_EVENT, { detail: { mode: 'folder' } })),
          },
        );
      }
      out.push({
        id: 'act-theme',
        section: '操作',
        icon: colorScheme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />,
        label: colorScheme === 'dark' ? '切换到亮色模式' : '切换到暗色模式',
        run: () => toggleColorScheme(),
      });
      if (currentSpaceId) {
        out.push({
          id: 'act-activity',
          section: '导航',
          icon: <IconClock size={15} />,
          label: '查看最近活动',
          run: () => navigate(`/spaces/${currentSpaceId}/activity`),
        });
      }
      out.push({
        id: 'act-plaza',
        section: '导航',
        icon: <IconLayoutGrid size={15} />,
        label: '打开广场',
        run: () => navigate('/plaza'),
      });
      out.push({
        id: 'act-devices',
        section: '导航',
        icon: <IconDeviceDesktop size={15} />,
        label: '打开设备',
        run: () => navigate('/devices'),
      });
      for (const space of spaces) {
        out.push({
          id: `space-${space.id}`,
          section: '空间',
          icon: <IconFolder size={15} />,
          label: space.name,
          hint: '切换空间',
          run: () => navigate(`/spaces/${space.id}`),
        });
      }
      return out;
    }

    // With a query: bookmark matches first, then a deep-search action.
    const matches = nodes
      .filter(
        (n) =>
          n.type === 'bookmark' &&
          (n.title.toLowerCase().includes(q) || (n.url ?? '').toLowerCase().includes(q)),
      )
      .slice(0, 8);
    for (const n of matches) {
      out.push({
        id: `node-${n.id}`,
        section: '书签',
        icon: <IconBookmark size={15} />,
        label: n.title,
        hint: extractHost(n.url ?? ''),
        run: () => {
          requestFocusNode(n.id);
          navigate(`/spaces/${n.space_id}`);
          window.dispatchEvent(new CustomEvent(FOCUS_NODE_EVENT, { detail: { nodeId: n.id } }));
        },
      });
    }
    out.push({
      id: 'act-search-page',
      section: '导航',
      icon: <IconSearch size={15} />,
      label: `在所有空间中搜索 “${query.trim()}”`,
      run: () => navigate(`/search?q=${encodeURIComponent(query.trim())}`),
    });
    return out;
  }, [q, query, spacesData, nodesData, currentSpaceId, colorScheme, navigate, toggleColorScheme]);

  useEffect(() => setActive(0), [items.length, q]);

  const runItem = (item: PaletteItem) => {
    onClose();
    item.run();
  };

  const sections = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={480}
      padding={0}
      centered
      overlayProps={{ blur: 2 }}
      styles={{ content: { overflow: 'hidden' } }}
      withCloseButton={false}
    >
      <TextInput
        placeholder="搜索书签、空间或操作…"
        value={query}
        autoFocus
        leftSection={<IconSearch size={15} />}
        styles={{ input: { border: 'none', boxShadow: 'none' } }}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            const item = items[active];
            if (item) runItem(item);
          }
        }}
      />
      <div
        ref={listRef}
        style={{ maxHeight: 320, overflowY: 'auto', borderTop: `1px solid ${tokens.subtleBorder}` }}
      >
        {items.length === 0 && (
          <div style={{ padding: 16, fontSize: 13, color: tokens.textSecondary }}>没有匹配项</div>
        )}
        {sections.map(([section, list]) => (
          <div key={section}>
            <div style={{ padding: '8px 16px 4px', fontSize: 11, color: tokens.textSecondary }}>
              {section}
            </div>
            {list.map((item) => {
              const idx = items.indexOf(item);
              const isActive = idx === active;
              return (
                <button
                  key={item.id}
                  onClick={() => runItem(item)}
                  onMouseEnter={() => setActive(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 16px',
                    fontSize: 13,
                    textAlign: 'left',
                    color: tokens.textPrimary,
                    backgroundColor: isActive ? tokens.hoverBg : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ color: tokens.textSecondary, display: 'inline-flex' }}>{item.icon}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.label}
                  </span>
                  {item.hint && (
                    <span style={{ fontSize: 11, color: tokens.textSecondary }}>{item.hint}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}
