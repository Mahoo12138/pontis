import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ParentRef } from '@pontis/api';
import Header from '../components/app-shell/Header';
import Toolbar from '../components/app-shell/Toolbar';
import BookmarkExplorer from '../components/explorer/BookmarkExplorer';
import { NewNodeModal, ConfirmDeleteDialog } from '../components/explorer/node-modals';
import type { NewNodeMode } from '../components/explorer/node-modals';
import { contentRegion } from '../styles/app-shell.css';
import { useNodes, useRootSlots } from '../hooks/use-nodes';
import { useSpaces } from '../hooks/use-spaces';
import { useNodeCrud } from '../hooks/use-node-crud';
import { buildTreeIndex, useExplorerState } from '../features/explorer';
import type { ExplorerFilter } from '../features/explorer';

export default function SpaceExplorerPage() {
  const { spaceId } = useParams();
  const [filter, setFilter] = useState<ExplorerFilter>('all');

  const { data: nodesData, isLoading } = useNodes(spaceId);
  const { data: slotsData } = useRootSlots(spaceId);
  const { data: spacesData } = useSpaces();

  const nodes = useMemo(() => nodesData?.nodes ?? [], [nodesData]);
  const index = useMemo(() => buildTreeIndex(nodes), [nodes]);
  const state = useExplorerState(index, filter);
  const crud = useNodeCrud(spaceId);

  const [createMode, setCreateMode] = useState<NewNodeMode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const spaceName = spacesData?.spaces?.find((s) => s.id === spaceId)?.name ?? '空间';

  // New nodes land in the single selected folder, else the first root slot.
  const selectedIds = useMemo(() => [...state.selected], [state.selected]);
  const singleId = selectedIds.length === 1 ? selectedIds[0] : undefined;
  const singleSelected = singleId ? index.byId.get(singleId) : undefined;
  const parentFolder = singleSelected?.type === 'folder' ? singleSelected : undefined;
  const rootSlot = slotsData?.root_slots?.[0];
  const parentRef: ParentRef = parentFolder
    ? { type: 'node', id: parentFolder.id }
    : { type: 'root', key: rootSlot?.key ?? 'main' };
  const parentLabel = parentFolder?.title ?? rootSlot?.display_name ?? '根目录';

  const handleCreate = (values: { title: string; url?: string }) => {
    if (!createMode) return;
    crud.create.mutate(
      { type: createMode, title: values.title, url: values.url, parent: parentRef },
      {
        onSuccess: () => {
          setCreateMode(null);
          if (createMode === 'folder' && parentFolder) {
            // reveal the new folder's contents context
            if (!state.expanded.has(parentFolder.id)) state.toggleExpand(parentFolder.id);
          }
        },
      },
    );
  };

  // Deleting a folder removes its subtree too (client-side expansion of
  // the selection so the mock and the future backend agree on scope).
  const deleteIds = useMemo(() => {
    const ids = new Set<string>();
    const collect = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of index.childrenOf(id)) collect(child.id);
    };
    for (const id of selectedIds) collect(id);
    return [...ids];
  }, [selectedIds, index]);

  const handleDeleteConfirm = () => {
    crud.remove.mutate(deleteIds, {
      onSuccess: () => {
        setDeleteOpen(false);
        state.clearSelection();
      },
    });
  };

  const handleCommitRename = (id: string, title: string) => {
    setRenamingId(null);
    crud.update.mutate({ nodeId: id, params: { title } });
  };

  return (
    <>
      <Header
        breadcrumb={spaceName}
        onNewBookmark={() => setCreateMode('bookmark')}
        onNewFolder={() => setCreateMode('folder')}
      />
      <Toolbar filter={filter} onFilterChange={setFilter} />
      <div className={contentRegion}>
        <BookmarkExplorer
          isLoading={isLoading}
          index={index}
          state={state}
          renamingId={renamingId}
          onStartRename={setRenamingId}
          onCommitRename={handleCommitRename}
          onDeleteKey={() => setDeleteOpen(true)}
        />
      </div>

      <NewNodeModal
        opened={createMode !== null}
        mode={createMode ?? 'bookmark'}
        parentLabel={parentLabel}
        pending={crud.create.isPending}
        onClose={() => setCreateMode(null)}
        onSubmit={handleCreate}
      />

      <ConfirmDeleteDialog
        opened={deleteOpen}
        count={deleteIds.length}
        pending={crud.remove.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
