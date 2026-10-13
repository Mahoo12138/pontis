// Binding a space to a browser folder — the step that turns a paired device
// into a syncing one. Shared by the guide and by 同步管理, because "add another
// space" is a settings action even though "add the first one" is onboarding.

import { useState } from 'react';
import { Button, Group, Select, Stack, Text } from '@mantine/core';
import { FolderPickerField } from './FolderPickerField';
import type { FolderTreeNode } from './folderTree';

export interface SpaceOption {
  id: string;
  name: string;
}

export function BindForm({
  spaces,
  folders,
  boundSpaceIds = [],
  busy = false,
  onBind,
}: {
  spaces: SpaceOption[];
  folders: FolderTreeNode[];
  /** Spaces this device already syncs. Nothing stops a second binding onto a
   *  different folder, so the list says so rather than looking like a bug. */
  boundSpaceIds?: string[];
  busy?: boolean;
  onBind: (spaceId: string, folderId: string, spaceName: string) => void;
}) {
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);

  const bound = new Set(boundSpaceIds);
  const submit = () => {
    if (!spaceId || !folderId) return;
    const space = spaces.find((s) => s.id === spaceId);
    onBind(spaceId, folderId, space?.name ?? spaceId);
    setSpaceId(null);
    setFolderId(null);
  };

  return (
    <Stack gap="sm">
      <Group grow align="flex-start" wrap="wrap">
        <Select
          label="同步空间"
          placeholder="选择空间"
          data={spaces.map((s) => ({
            value: s.id,
            label: bound.has(s.id) ? `${s.name}（已绑定）` : s.name,
          }))}
          value={spaceId}
          onChange={setSpaceId}
          style={{ minWidth: 240 }}
        />
        <FolderPickerField
          tree={folders}
          value={folderId ?? ''}
          onChange={setFolderId}
          label="挂载目录"
          description="挂载目录里的书签会和该空间保持同步，目录本身不会被上传。"
          placeholder="选择书签目录"
          loading={false}
          groupName="mount-folder"
        />
      </Group>
      {spaces.length === 0 && (
        <Text size="xs" c="dimmed">
          这个账号在服务器上还没有空间，请先在 Web 端创建一个。
        </Text>
      )}
      <Group gap="xs">
        <Button onClick={submit} loading={busy} disabled={!spaceId || !folderId}>
          创建绑定
        </Button>
      </Group>
    </Stack>
  );
}
