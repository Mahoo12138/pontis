import { Group, SegmentedControl } from '@mantine/core';
import { IconArrowsSort, IconLink } from '@tabler/icons-react';
import { toolbarRegion } from '../../styles/app-shell.css';
import { tokens } from '../../styles/semantic-tokens.css';

interface ToolbarProps {
  filter: 'all' | 'folders' | 'bookmarks';
  onFilterChange: (filter: 'all' | 'folders' | 'bookmarks') => void;
}

export default function Toolbar({ filter, onFilterChange }: ToolbarProps) {
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
        <Group gap={4} style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}>
          <IconArrowsSort size={14} stroke={1.5} />
          排序
        </Group>
        <Group gap={4} style={{ fontSize: '12px', color: tokens.textSecondary, cursor: 'pointer' }}>
          <IconLink size={14} stroke={1.5} />
          检查失效链接
        </Group>
      </Group>
    </div>
  );
}
