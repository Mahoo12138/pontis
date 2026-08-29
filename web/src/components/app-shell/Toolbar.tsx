import { Group, SegmentedControl, Tooltip } from '@mantine/core';
import { IconArrowsSort, IconLink, IconInfoCircle, IconFileImport, IconFileExport } from '@tabler/icons-react';
import { toolbarRegion } from '../../styles/app-shell.css';
import { tokens } from '../../styles/semantic-tokens.css';

interface ToolbarProps {
  filter: 'all' | 'folders' | 'bookmarks';
  onFilterChange: (filter: 'all' | 'folders' | 'bookmarks') => void;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  onImport?: () => void;
  onExport?: () => void;
}

export default function Toolbar({
  filter,
  onFilterChange,
  inspectorOpen,
  onToggleInspector,
  onImport,
  onExport,
}: ToolbarProps) {
  return (
    <div className={toolbarRegion}>
      <SegmentedControl
        size="xs"
        value={filter}
        onChange={(v) => onFilterChange(v as ToolbarProps['filter'])}
        data={[
          { label: '全部', value: 'all' },
          { label: '文件夹', value: 'folders' },
          { label: '书签', value: 'bookmarks' },
        ]}
        styles={{
          root: { backgroundColor: tokens.hoverBg },
        }}
      />

      <Group gap="xs" style={{ marginLeft: 'auto' }}>
        {onImport && (
          <button
            onClick={onImport}
            aria-label="导入书签"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 6px',
              fontSize: '12px',
              color: tokens.textSecondary,
              backgroundColor: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = tokens.hoverBg)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <IconFileImport size={14} stroke={1.5} />
            导入
          </button>
        )}
        {onExport && (
          <button
            onClick={onExport}
            aria-label="导出书签"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 6px',
              fontSize: '12px',
              color: tokens.textSecondary,
              backgroundColor: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = tokens.hoverBg)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <IconFileExport size={14} stroke={1.5} />
            导出
          </button>
        )}
        <Group gap={4} style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}>
          <IconArrowsSort size={14} stroke={1.5} />
          排序
        </Group>
        <Group gap={4} style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}>
          <IconLink size={14} stroke={1.5} />
          检查失效链接
        </Group>
        <Tooltip label={inspectorOpen ? '关闭详情' : '打开详情'}>
          <Group
            gap={4}
            onClick={onToggleInspector}
            style={{
              fontSize: '12px',
              cursor: 'pointer',
              color: inspectorOpen ? tokens.accent : tokens.textSecondary,
            }}
          >
            <IconInfoCircle size={14} stroke={1.5} />
            详情
          </Group>
        </Tooltip>
      </Group>
    </div>
  );
}
