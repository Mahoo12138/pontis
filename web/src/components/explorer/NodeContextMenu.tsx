import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  IconExternalLink,
  IconCopy,
  IconEdit,
  IconTrash,
  IconBookmark,
  IconFolderPlus,
  IconTransferOut,
} from '@tabler/icons-react';
import type { Node } from '@pontis/api';
import { openUrlSafely } from '../../lib/safe-url';
import { tokens } from '../../styles/semantic-tokens.css';

export interface ContextMenuPos {
  x: number;
  y: number;
}

interface NodeContextMenuProps {
  pos: ContextMenuPos | null;
  node: Node | null;
  onClose: () => void;
  onCopyUrl: (node: Node) => void;
  onRename: (node: Node) => void;
  onCreateInside: (node: Node, mode: 'bookmark' | 'folder') => void;
  onDelete: (node: Node) => void;
  onTransfer: (node: Node) => void;
}

const MENU_W = 176;
const ROW_H = 30;

/** Cursor-anchored context menu for explorer rows (floating surface). */
export default function NodeContextMenu({
  pos,
  node,
  onClose,
  onCopyUrl,
  onRename,
  onCreateInside,
  onDelete,
  onTransfer,
}: NodeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside press, Escape, or scroll.
  useEffect(() => {
    if (!pos) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const scroll = () => onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [pos, onClose]);

  if (!pos || !node) return null;

  const isFolder = node.type === 'folder';
  const items: { icon: ReactNode; label: string; danger?: boolean; run: () => void }[] = isFolder
    ? [
        { icon: <IconBookmark size={14} />, label: '新建书签', run: () => onCreateInside(node, 'bookmark') },
        { icon: <IconFolderPlus size={14} />, label: '新建文件夹', run: () => onCreateInside(node, 'folder') },
        { icon: <IconEdit size={14} />, label: '重命名', run: () => onRename(node) },
        { icon: <IconTransferOut size={14} />, label: '转移到空间…', run: () => onTransfer(node) },
        { icon: <IconTrash size={14} />, label: '删除', danger: true, run: () => onDelete(node) },
      ]
    : [
        { icon: <IconExternalLink size={14} />, label: '打开链接', run: () => openUrlSafely(node.url ?? '') },
        { icon: <IconCopy size={14} />, label: '复制链接', run: () => onCopyUrl(node) },
        { icon: <IconEdit size={14} />, label: '重命名', run: () => onRename(node) },
        { icon: <IconTransferOut size={14} />, label: '转移到空间…', run: () => onTransfer(node) },
        { icon: <IconTrash size={14} />, label: '删除', danger: true, run: () => onDelete(node) },
      ];

  const estH = items.length * ROW_H + 10;
  const x = Math.min(pos.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(pos.y, window.innerHeight - estH - 8);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        width: MENU_W,
        zIndex: 300,
        padding: '4px',
        backgroundColor: tokens.workspaceBg,
        border: `1px solid ${tokens.subtleBorder}`,
        borderRadius: '8px',
        boxShadow: 'var(--mantine-shadow-md)',
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            height: ROW_H,
            padding: '0 8px',
            fontSize: 13,
            textAlign: 'left',
            color: item.danger ? tokens.syncError : tokens.textPrimary,
            backgroundColor: 'transparent',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = tokens.hoverBg; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
