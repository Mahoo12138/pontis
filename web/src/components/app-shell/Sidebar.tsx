import { useNavigate, useLocation } from 'react-router-dom';
import { ActionIcon, Tooltip, useMantineColorScheme } from '@mantine/core';
import {
  IconFolder,
  IconPlus,
  IconLayoutGrid,
  IconClock,
  IconDeviceDesktop,
  IconSettings,
  IconSun,
  IconMoon,
} from '@tabler/icons-react';
import {
  sidebarLogo,
  sidebarSection,
  sidebarSectionLabel,
  sidebarItem,
  sidebarItemSelected,
  sidebarDivider,
  sidebarUser,
  sidebarItemIcon,
} from '../../styles/sidebar.css';
import { tokens } from '../../styles/semantic-tokens.css';
import { useSpaces } from '../../hooks/use-spaces';

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  const { data: spacesData } = useSpaces();
  const spaces = spacesData?.spaces ?? [];

  const currentPath = location.pathname;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Logo */}
      <div className={sidebarLogo}>
        <IconLayoutGrid size={20} stroke={1.5} style={{ color: tokens.accent }} />
        Pontis
      </div>

      {/* Spaces section */}
      <div className={sidebarSectionLabel}>空间</div>
      <div className={sidebarSection}>
        {spaces.map((space) => (
          <div
            key={space.id}
            className={`${sidebarItem} ${currentPath === `/spaces/${space.id}` ? sidebarItemSelected : ''}`}
            onClick={() => navigate(`/spaces/${space.id}`)}
          >
            <IconFolder size={16} stroke={1.5} className={sidebarItemIcon} />
            {space.name}
          </div>
        ))}
        <div className={sidebarItem} style={{ color: tokens.textSecondary }}>
          <IconPlus size={16} stroke={1.5} className={sidebarItemIcon} />
          新建空间
        </div>
      </div>

      <hr className={sidebarDivider} />

      {/* Navigation */}
      <div className={sidebarSection}>
        <div className={`${sidebarItem} ${currentPath === '/plaza' ? sidebarItemSelected : ''}`}>
          <IconLayoutGrid size={16} stroke={1.5} className={sidebarItemIcon} />
          广场
        </div>
        <div className={`${sidebarItem} ${currentPath === '/activity' ? sidebarItemSelected : ''}`}>
          <IconClock size={16} stroke={1.5} className={sidebarItemIcon} />
          最近活动
        </div>
      </div>

      <hr className={sidebarDivider} />

      <div className={sidebarSection}>
        <div className={`${sidebarItem} ${currentPath === '/devices' ? sidebarItemSelected : ''}`}>
          <IconDeviceDesktop size={16} stroke={1.5} className={sidebarItemIcon} />
          设备
        </div>
        <div className={`${sidebarItem} ${currentPath === '/settings' ? sidebarItemSelected : ''}`}>
          <IconSettings size={16} stroke={1.5} className={sidebarItemIcon} />
          设置
        </div>
      </div>

      {/* User area at bottom */}
      <div className={sidebarUser}>
        <span style={{ flex: 1 }}>admin</span>
        <Tooltip label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => toggleColorScheme()}
            aria-label="Toggle color scheme"
          >
            {colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
          </ActionIcon>
        </Tooltip>
      </div>
    </div>
  );
}
