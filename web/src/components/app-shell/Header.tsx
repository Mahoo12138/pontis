import { TextInput, Group, Badge } from '@mantine/core';
import { IconSearch, IconPlus, IconCloudCheck } from '@tabler/icons-react';
import { headerRegion } from '../../styles/app-shell.css';
import { tokens } from '../../styles/semantic-tokens.css';

interface HeaderProps {
  breadcrumb?: string;
  onNewBookmark?: () => void;
}

export default function Header({ breadcrumb, onNewBookmark }: HeaderProps) {
  return (
    <div className={headerRegion}>
      <Group gap="xs" style={{ flex: 1 }}>
        {breadcrumb && (
          <span style={{ fontSize: '14px', color: tokens.textSecondary }}>
            {breadcrumb}
          </span>
        )}
      </Group>

      <Group gap="sm">
        <TextInput
          placeholder="搜索书签、文件夹… ⌘K"
          leftSection={<IconSearch size={14} stroke={1.5} />}
          w={320}
          styles={{ input: { height: '34px', fontSize: '13px' } }}
        />

        <Badge
          variant="light"
          color="healthyGreen"
          leftSection={<IconCloudCheck size={12} />}
          styles={{ root: { fontWeight: 400 } }}
        >
          已同步
        </Badge>

        <button
          onClick={onNewBookmark}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 10px',
            fontSize: '13px',
            fontWeight: 500,
            color: 'white',
            backgroundColor: tokens.accent,
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          <IconPlus size={14} stroke={1.5} />
          新建
        </button>
      </Group>
    </div>
  );
}
