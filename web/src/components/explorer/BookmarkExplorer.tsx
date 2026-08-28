import { useState, useMemo } from 'react';
import { Group, Text, ActionIcon, Skeleton } from '@mantine/core';
import {
  IconChevronRight,
  IconFolder,
  IconDots,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useNodes } from '../../hooks/use-nodes';
import { formatShortTime, extractHost } from '../../lib/format';
import {
  explorerContainer,
  explorerColumnHeader,
  explorerRow,
  explorerRowSelected,
  explorerRowIcon,
  explorerRowTitle,
  explorerRowTitleFolder,
  explorerRowMeta,
  explorerRowTime,
  explorerRowActions,
  favicon,
} from '../../styles/explorer.css';
import { tokens } from '../../styles/semantic-tokens.css';
import type { Node } from '@pontis/api';

interface BookmarkExplorerProps {
  spaceId?: string;
  filter: 'all' | 'folders' | 'bookmarks';
}

/** Build a tree structure from flat node list. */
interface TreeNode extends Node {
  children: TreeNode[];
}

function buildTree(nodes: Node[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Create tree nodes
  for (const node of nodes) {
    map.set(node.id, { ...node, children: [] });
  }

  // Build parent-child relationships
  for (const node of nodes) {
    const treeNode = map.get(node.id)!;
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(treeNode);
    } else if (node.root_key) {
      roots.push(treeNode);
    }
  }

  // Sort by position
  const sortChildren = (items: TreeNode[]) => {
    items.sort((a, b) => a.position - b.position);
    for (const item of items) sortChildren(item.children);
  };
  sortChildren(roots);

  return roots;
}

export default function BookmarkExplorer({ spaceId, filter }: BookmarkExplorerProps) {
  const { data: nodesData, isLoading } = useNodes(spaceId);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const nodes = nodesData?.nodes ?? [];
  const tree = useMemo(() => buildTree(nodes), [nodes]);

  const toggleExpand = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Flatten the tree for rendering, respecting expand/collapse. */
  const flatRows: TreeNode[] = [];
  const walk = (items: TreeNode[], depth: number) => {
    for (const item of items) {
      if (filter === 'folders' && item.type === 'bookmark') continue;
      if (filter === 'bookmarks' && item.type === 'folder') continue;
      flatRows.push(item);
      if (item.type === 'folder' && expandedFolders.has(item.id)) {
        walk(item.children, depth + 1);
      }
    }
  };
  walk(tree, 0);

  if (isLoading) {
    return (
      <div className={explorerContainer} style={{ padding: '16px' }}>
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} height={38} mb={2} />
        ))}
      </div>
    );
  }

  if (flatRows.length === 0) {
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
    <div className={explorerContainer}>
      {/* Column header */}
      <div className={explorerColumnHeader}>
        <span style={{ flex: 1 }}>名称</span>
        <span style={{ width: '200px' }}>链接</span>
        <span style={{ width: '60px', textAlign: 'right' }}>时间</span>
      </div>

      {/* Rows */}
      {flatRows.map((node) => {
        const isSelected = node.id === selectedId;
        const isExpanded = expandedFolders.has(node.id);

        return (
          <div
            key={node.id}
            className={`${explorerRow} ${isSelected ? explorerRowSelected : ''}`}
            onClick={() => setSelectedId(node.id)}
            onDoubleClick={() => {
              if (node.type === 'folder') toggleExpand(node.id);
            }}
          >
            {/* Folder row */}
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
                <span className={`${explorerRowTitle} ${explorerRowTitleFolder}`}>{node.title}</span>
                <span className={explorerRowMeta}>{node.children.length} 项</span>
              </>
            ) : (
              <>
                <img
                  className={favicon}
                  src={`https://www.google.com/s2/favicons?domain=${extractHost(node.url ?? '')}&sz=16`}
                  alt=""
                />
                <span className={explorerRowTitle}>{node.title}</span>
                <span className={explorerRowMeta}>{extractHost(node.url ?? '')}</span>
                <span className={explorerRowTime}>{formatShortTime(node.updated_at)}</span>
              </>
            )}

            {/* Hover actions */}
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
