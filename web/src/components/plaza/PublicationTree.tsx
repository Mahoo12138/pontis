import { useState } from 'react';
import { Text } from '@mantine/core';
import {
  IconBookmark,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
} from '@tabler/icons-react';
import type { PublicationNodeDTO } from '@pontis/api';
import { tokens } from '../../styles/semantic-tokens.css';
import { extractHost } from '../../lib/format';

/**
 * Read-only collapsible rendering of a published share tree.
 * Follows the explorer idiom (32px rows, restrained icons) without
 * the full explorer machinery — publications are snapshots, not live nodes.
 */
export default function PublicationTree({ root }: { root: PublicationNodeDTO }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
          <Text fz={13} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.title}
          </Text>
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
          <Text fz={13} fw={500} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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

  return <div>{renderNode(root, 0)}</div>;
}
