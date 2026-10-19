import { useMemo, useState } from 'react';
import { ActionIcon, Group, Text, Tooltip } from '@mantine/core';
import {
  IconBookmark,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconFolder,
} from '@tabler/icons-react';
import type { PublicationNodeDTO } from '@pontis/api';
import { tokens } from '../../styles/semantic-tokens.css';
import { extractHost } from '../../lib/format';

/**
 * Read-only collapsible rendering of a published share tree.
 * Follows the explorer idiom (32px rows, restrained icons) without
 * the full explorer machinery — publications are snapshots, not live nodes.
 *
 * A published URL is untrusted input (doc 10 §12): only an absolute http(s)
 * one becomes a link, and it opens in a fresh tab that cannot reach back into
 * this origin. Anything else stays plain text, so a bookmarklet inside a
 * collection cannot be clicked into life.
 */
export default function PublicationTree({ root }: { root: PublicationNodeDTO }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The published root is the collection itself and always stands open, so it
  // is left out of what "collapse everything" folds away.
  const innerFolderIds = useMemo(() => collectFolderIds(root).slice(1), [root]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (node: PublicationNodeDTO, depth: number) => {
    if (node.type === 'bookmark') {
      const href = webUrl(node.url);
      const label = (
        <Text
          fz={13}
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {node.title}
        </Text>
      );
      return (
        <div
          key={node.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            paddingLeft: 12 + depth * 20,
            paddingRight: 12,
          }}
        >
          <IconBookmark size={15} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={node.url ?? undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                color: tokens.textPrimary,
                textDecoration: 'none',
              }}
            >
              {label}
              <IconExternalLink
                size={12}
                stroke={1.5}
                style={{ color: tokens.textSecondary, flexShrink: 0 }}
              />
            </a>
          ) : (
            label
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: tokens.textSecondary, flexShrink: 0 }}>
            {extractHost(node.url ?? '')}
          </span>
        </div>
      );
    }

    const isCollapsed = collapsed.has(node.id);
    const children = node.children ?? [];
    const directBookmarks = children.filter((c) => c.type === 'bookmark').length;
    return (
      <div key={node.id}>
        <button
          onClick={() => toggle(node.id)}
          aria-expanded={!isCollapsed}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            height: 32,
            paddingLeft: 8 + depth * 20,
            paddingRight: 12,
            backgroundColor: 'transparent',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            textAlign: 'left',
            color: tokens.textPrimary,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = tokens.hoverBg)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          {isCollapsed ? (
            <IconChevronRight size={13} stroke={1.7} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
          ) : (
            <IconChevronDown size={13} stroke={1.7} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
          )}
          <IconFolder size={15} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
          <Text
            fz={13}
            fw={500}
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {node.title}
          </Text>
          {directBookmarks > 0 && (
            <span style={{ fontSize: 12, color: tokens.textSecondary }}>{directBookmarks}</span>
          )}
        </button>
        {!isCollapsed && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      {innerFolderIds.length > 0 && (
        <Group gap={2} justify="flex-end" px={10} pb={2}>
          <Tooltip label="展开全部">
            <ActionIcon
              variant="subtle"
              color="coolGray"
              size="xs"
              aria-label="展开全部"
              onClick={() => setCollapsed(new Set())}
            >
              <IconChevronDown size={14} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="收起全部">
            <ActionIcon
              variant="subtle"
              color="coolGray"
              size="xs"
              aria-label="收起全部"
              onClick={() => setCollapsed(new Set(innerFolderIds))}
            >
              <IconChevronRight size={14} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
      {renderNode(root, 0)}
    </div>
  );
}

/** Absolute http(s) only: a stored `javascript:` or relative value stays text. */
function webUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

/** Folder ids in tree order, the published root first. */
function collectFolderIds(node: PublicationNodeDTO, acc: string[] = []): string[] {
  if (node.type === 'bookmark') return acc;
  acc.push(node.id);
  for (const child of node.children ?? []) collectFolderIds(child, acc);
  return acc;
}
