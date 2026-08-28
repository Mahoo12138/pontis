import type { ReactNode } from 'react';
import { ActionIcon, Badge, Text, Tooltip } from '@mantine/core';
import { IconExternalLink, IconCopy, IconX } from '@tabler/icons-react';
import type { Node } from '@pontis/api';
import { formatRelativeTime, extractHost } from '../../lib/format';
import { openUrlSafely } from '../../lib/safe-url';
import { tokens } from '../../styles/semantic-tokens.css';

interface InspectorProps {
  node: Node;
  onClose: () => void;
  onCopyUrl: (node: Node) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Text fz={11} c={tokens.textSecondary} mb={4}>{label}</Text>
      <Text fz={13} c={tokens.textPrimary} style={{ wordBreak: 'break-all' }}>
        {children}
      </Text>
    </div>
  );
}

/**
 * On-demand right panel (inspectorWidth). Shows details for the single
 * selected node; never squeezes the explorer when closed.
 */
export default function Inspector({ node, onClose, onCopyUrl }: InspectorProps) {
  const isFolder = node.type === 'folder';

  return (
    <aside
      style={{
        width: tokens.inspectorWidth,
        flexShrink: 0,
        borderLeft: `1px solid ${tokens.subtleBorder}`,
        backgroundColor: tokens.workspaceBg,
        padding: '16px',
        overflowY: 'auto',
      }}
      aria-label="详情"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Badge variant="light" color={isFolder ? 'coolGray' : 'accentBlue'}>
          {isFolder ? '文件夹' : '书签'}
        </Badge>
        <span style={{ flex: 1 }} />
        <ActionIcon variant="subtle" size="xs" onClick={onClose} aria-label="关闭详情">
          <IconX size={14} />
        </ActionIcon>
      </div>

      <Field label="名称">{node.title}</Field>

      {!isFolder && node.url && (
        <>
          <Field label="链接">
            <span style={{ color: tokens.textSecondary }}>{extractHost(node.url)}</span>
            <br />
            {node.url}
          </Field>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <Tooltip label="在新标签页打开（rel=noopener）">
              <ActionIcon
                variant="light"
                size="sm"
                onClick={() => openUrlSafely(node.url!)}
                aria-label="打开链接"
              >
                <IconExternalLink size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="复制链接">
              <ActionIcon
                variant="light"
                size="sm"
                onClick={() => onCopyUrl(node)}
                aria-label="复制链接"
              >
                <IconCopy size={14} />
              </ActionIcon>
            </Tooltip>
          </div>
        </>
      )}

      <Field label="创建时间">{formatRelativeTime(node.created_at)}</Field>
      <Field label="更新时间">{formatRelativeTime(node.updated_at)}</Field>
      <Field label="结构修订">r{node.structure_revision}</Field>
      <Field label="ID">
        <span style={{ color: tokens.textSecondary, fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 11 }}>
          {node.id}
        </span>
      </Field>
    </aside>
  );
}
