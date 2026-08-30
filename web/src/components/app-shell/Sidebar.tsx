import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  TextInput,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import {
  IconFolder,
  IconPlus,
  IconLayoutGrid,
  IconClock,
  IconDeviceDesktop,
  IconListCheck,
  IconSettings,
  IconShieldHalf,
  IconSun,
  IconMoon,
  IconLogout,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useMe, useLogout } from '../../hooks/use-auth';
import { useSpaces, useCreateSpace } from '../../hooks/use-spaces';
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

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const { data: me } = useMe();
  const logout = useLogout();

  const { data: spacesData } = useSpaces();
  const spaces = spacesData?.spaces ?? [];
  const createSpace = useCreateSpace();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => navigate('/login'),
    });
  };

  const handleCreateSpace = () => {
    const name = newName.trim();
    if (name.length < 1) {
      setCreateError('空间名称不能为空');
      return;
    }
    setCreateError(null);
    createSpace.mutate(
      { name },
      {
        onSuccess: (space) => {
          setCreateOpen(false);
          setNewName('');
          navigate(`/spaces/${space.id}`);
        },
        onError: (e) => setCreateError(e instanceof Error ? e.message : '创建失败'),
      },
    );
  };

  const currentPath = location.pathname;

  // 最近活动 is per-space: follow the open space, else the first one.
  const spaceMatch = currentPath.match(/^\/spaces\/([^/]+)/);
  const activitySpaceId = spaceMatch?.[1] ?? spaces[0]?.id;
  const activityPath = activitySpaceId ? `/spaces/${activitySpaceId}/activity` : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Logo */}
      <div className={sidebarLogo}>
        <IconLayoutGrid size={20} stroke={1.5} style={{ color: tokens.accent }} />
        Pontis
      </div>

      {/* Spaces section */}
      <div className={sidebarSectionLabel}>{t('sidebar:spaces')}</div>
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
        <div
          className={sidebarItem}
          style={{ color: tokens.textSecondary, cursor: 'pointer' }}
          onClick={() => setCreateOpen(true)}
        >
          <IconPlus size={16} stroke={1.5} className={sidebarItemIcon} />
          {t('sidebar:new_space')}
        </div>
      </div>

      <hr className={sidebarDivider} />

      {/* Navigation */}
      <div className={sidebarSection}>
        <div
          className={`${sidebarItem} ${currentPath.startsWith('/plaza') ? sidebarItemSelected : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/plaza')}
        >
          <IconLayoutGrid size={16} stroke={1.5} className={sidebarItemIcon} />
          {t('sidebar:plaza')}
        </div>
        <div
          className={`${sidebarItem} ${activityPath && currentPath === activityPath ? sidebarItemSelected : ''}`}
          style={{ cursor: activityPath ? 'pointer' : undefined, color: activityPath ? undefined : tokens.textDisabled }}
          onClick={() => activityPath && navigate(activityPath)}
        >
          <IconClock size={16} stroke={1.5} className={sidebarItemIcon} />
          {t('sidebar:recent_activity')}
        </div>
      </div>

      <hr className={sidebarDivider} />

      <div className={sidebarSection}>
        <div
          className={`${sidebarItem} ${currentPath === '/devices' ? sidebarItemSelected : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/devices')}
        >
          <IconDeviceDesktop size={16} stroke={1.5} className={sidebarItemIcon} />
          {t('sidebar:devices')}
        </div>
        <div
          className={`${sidebarItem} ${currentPath === '/tasks' ? sidebarItemSelected : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/tasks')}
        >
          <IconListCheck size={16} stroke={1.5} className={sidebarItemIcon} />
          任务
        </div>
        <div
          className={`${sidebarItem} ${currentPath.startsWith('/settings') ? sidebarItemSelected : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/settings')}
        >
          <IconSettings size={16} stroke={1.5} className={sidebarItemIcon} />
          {t('sidebar:settings')}
        </div>
        {me?.role === 'admin' && (
          <div
            className={`${sidebarItem} ${currentPath.startsWith('/admin') ? sidebarItemSelected : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/admin')}
          >
            <IconShieldHalf size={16} stroke={1.5} className={sidebarItemIcon} />
            {t('sidebar:admin')}
          </div>
        )}
      </div>

      {/* User area at bottom */}
      <div className={sidebarUser}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {me?.display_name || me?.username || '—'}
        </span>
        <Group gap={2}>
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
          <Tooltip label="退出登录">
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={handleLogout}
              aria-label="Log out"
            >
              <IconLogout size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </div>

      {/* Create space dialog */}
      <Modal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建空间"
        size="xs"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreateSpace();
          }}
        >
          <TextInput
            label="空间名称"
            placeholder="例如：工作"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            error={createError ?? undefined}
            data-autofocus
          />
          <Button
            type="submit"
            fullWidth
            mt="md"
            loading={createSpace.isPending}
          >
            创建
          </Button>
        </form>
      </Modal>
    </div>
  );
}
