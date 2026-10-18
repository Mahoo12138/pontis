import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Text,
  TextInput,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import {
  IconFolder,
  IconPlus,
  IconDots,
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
import { useSpaces, useCreateSpace, useRenameSpace, useDeleteSpace } from '../../hooks/use-spaces';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@pontis/api';
import type { Space } from '@pontis/api';
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
import { PontisLogo } from '../common/PontisLogo';

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

  const renameSpace = useRenameSpace();
  const delSpace = useDeleteSpace();
  const qc = useQueryClient();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<Space | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<Space | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openRename = (space: Space) => {
    setMenuFor(null);
    setRenameError(null);
    setRenameValue(space.name);
    setRenameFor(space);
  };

  const openDelete = (space: Space) => {
    setMenuFor(null);
    setDeleteError(null);
    setDeleteFor(space);
  };

  const handleRename = () => {
    if (!renameFor) return;
    setRenameError(null);
    renameSpace.mutate(
      { id: renameFor.id, name: renameValue },
      {
        onSuccess: () => setRenameFor(null),
        onError: (err) => setRenameError(spaceErrorText(err, t)),
      },
    );
  };

  const handleDelete = () => {
    if (!deleteFor) return;
    setDeleteError(null);
    delSpace.mutate(deleteFor.id, {
      onSuccess: () => {
        // Leave the deleted space's route before the cache refreshes, or the
        // explorer still mounted there refetches a space that is gone.
        if (location.pathname.startsWith(`/spaces/${deleteFor.id}`)) navigate('/');
        // exact: the node queries are keyed ['spaces', id, 'nodes'], so a
        // prefix match would refetch the space that has just been deleted.
        qc.invalidateQueries({ queryKey: ['spaces'], exact: true });
        setDeleteFor(null);
      },
      onError: (err) => setDeleteError(spaceErrorText(err, t)),
    });
  };

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
        <PontisLogo size={28} />
        Pontis
      </div>

      {/* Spaces section */}
      <div className={sidebarSectionLabel}>{t('sidebar:spaces')}</div>
      <div className={sidebarSection}>
        {spaces.map((space) => (
          <div
            key={space.id}
            className={`${sidebarItem} ${currentPath === `/spaces/${space.id}` ? sidebarItemSelected : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 2 }}
            onClick={() => navigate(`/spaces/${space.id}`)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(space.id);
            }}
          >
            <IconFolder size={16} stroke={1.5} className={sidebarItemIcon} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {space.name}
            </span>
            <Menu
              opened={menuFor === space.id}
              onChange={(opened) => setMenuFor(opened ? space.id : null)}
              withinPortal
            >
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  size="xs"
                  aria-label={t('sidebar:space_actions')}
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconDots size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => openRename(space)}>{t('sidebar:rename_space')}</Menu.Item>
                <Menu.Item onClick={() => openDelete(space)}>{t('sidebar:delete_space')}</Menu.Item>
              </Menu.Dropdown>
            </Menu>
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

      {/* Rename space dialog */}
      <Modal
        opened={!!renameFor}
        onClose={() => setRenameFor(null)}
        title={t('sidebar:rename_space')}
        size="xs"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleRename();
          }}
        >
          <TextInput
            label={t('sidebar:space_name')}
            value={renameValue}
            onChange={(e) => setRenameValue(e.currentTarget.value)}
            error={renameError ?? undefined}
            data-autofocus
          />
          <Button type="submit" fullWidth mt="md" loading={renameSpace.isPending}>
            {t('sidebar:save')}
          </Button>
        </form>
      </Modal>

      {/* Delete space dialog */}
      <Modal
        opened={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        title={t('sidebar:delete_space')}
        size="xs"
      >
        <Text fz="sm" c="dimmed">
          {t('sidebar:delete_space_hint')}
        </Text>
        {deleteFor && (
          <Text fz="sm" mt="xs">
            {deleteFor.name}
          </Text>
        )}
        {deleteError && (
          <Text fz="sm" c="red" mt="xs">
            {deleteError}
          </Text>
        )}
        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={() => setDeleteFor(null)}>
            {t('sidebar:cancel')}
          </Button>
          <Button color="red" loading={delSpace.isPending} onClick={handleDelete}>
            {t('sidebar:confirm_delete')}
          </Button>
        </Group>
      </Modal>
    </div>
  );
}

/**
 * A refused rename or deletion carries a code, not prose meant for the person
 * reading this UI: the server's message is English, so the codes this dialog
 * can actually hit get local text and anything else falls back to the message.
 */
function spaceErrorText(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError) {
    if (err.code === 'SPACE_NOT_EMPTY') return t('sidebar:delete_space_not_empty');
    if (err.code === 'INVALID_NAME') return t('sidebar:name_invalid');
    if (err.code === 'NOT_FOUND') return t('sidebar:space_gone');
  }
  const message = (err as { message?: string } | null)?.message;
  return message && message.trim() ? message : String(err);
}
