import type { ReactNode } from 'react';
import { TextInput, Group, Badge, Menu } from '@mantine/core';
import {
  IconSearch,
  IconPlus,
  IconCloudCheck,
  IconChevronDown,
  IconBookmark,
  IconFolderPlus,
  IconMenu2,
} from '@tabler/icons-react';
import { headerRegion, sidebarMenuButton } from '../../styles/app-shell.css';
import { tokens } from '../../styles/semantic-tokens.css';
import { OPEN_PALETTE_EVENT } from '../command-palette/CommandPalette';
import { TOGGLE_SIDEBAR_EVENT } from './AppShell';

interface HeaderProps {
  breadcrumb?: string;
  onNewBookmark?: () => void;
  onNewFolder?: () => void;
  /** Page-specific primary action; replaces the default 新建 menu. */
  primaryAction?: { label: string; icon?: ReactNode; onClick: () => void };
}

export default function Header({ breadcrumb, onNewBookmark, onNewFolder, primaryAction }: HeaderProps) {
  return (
    <div className={headerRegion}>
      <button
        className={sidebarMenuButton}
        aria-label="打开菜单"
        onClick={() => window.dispatchEvent(new CustomEvent(TOGGLE_SIDEBAR_EVENT))}
      >
        <IconMenu2 size={18} stroke={1.5} />
      </button>
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
          readOnly
          aria-label="打开命令面板"
          onFocus={(e) => {
            e.currentTarget.blur();
            window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
          }}
          styles={{ input: { height: '34px', fontSize: '13px', cursor: 'pointer' } }}
        />

        <Badge
          variant="light"
          color="healthyGreen"
          leftSection={<IconCloudCheck size={12} />}
          styles={{ root: { fontWeight: 400 } }}
        >
          已同步
        </Badge>

        {primaryAction ? (
          <button
            onClick={primaryAction.onClick}
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
            {primaryAction.icon ?? <IconPlus size={14} stroke={1.5} />}
            {primaryAction.label}
          </button>
        ) : onNewBookmark || onNewFolder ? (
          <Menu shadow="md" width={160} position="bottom-end">
            <Menu.Target>
              <button
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
                <IconChevronDown size={12} stroke={1.5} />
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconBookmark size={14} stroke={1.5} />}
                onClick={onNewBookmark}
              >
                新建书签
              </Menu.Item>
              <Menu.Item
                leftSection={<IconFolderPlus size={14} stroke={1.5} />}
                onClick={onNewFolder}
              >
                新建文件夹
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : null}
      </Group>
    </div>
  );
}
