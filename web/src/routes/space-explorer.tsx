import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Node, ParentRef } from '@pontis/api';
import Header from '../components/app-shell/Header';
import Toolbar from '../components/app-shell/Toolbar';
import BookmarkExplorer from '../components/explorer/BookmarkExplorer';
import NodeContextMenu from '../components/explorer/NodeContextMenu';
import type { ContextMenuPos } from '../components/explorer/NodeContextMenu';
import { NewNodeModal, ConfirmDeleteDialog } from '../components/explorer/node-modals';
import type { NewNodeMode } from '../components/explorer/node-modals';
import TransferModal from '../components/explorer/TransferModal';
import ImportModal from '../components/transfer/ImportModal';
import ExportModal from '../components/transfer/ExportModal';
import Inspector from '../components/inspector/Inspector';
import ErrorState from '../components/common/ErrorState';
import {
  CREATE_NODE_EVENT,
  FOCUS_NODE_EVENT,
  consumePendingFocus,
} from '../components/command-palette/CommandPalette';
import { contentRegion } from '../styles/app-shell.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useNodes, useRootSlots } from '../hooks/use-nodes';
import { useSpaces } from '../hooks/use-spaces';
import { useNodeCrud } from '../hooks/use-node-crud';
import { buildTreeIndex, useExplorerState } from '../features/explorer';
import type { ExplorerFilter } from '../features/explorer';

export default function SpaceExplorerPage() {
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ExplorerFilter>('all');

  const { data: nodesData, isLoading, isError, refetch } = useNodes(spaceId);
  const { data: slotsData } = useRootSlots(spaceId);
  const { data: spacesData } = useSpaces();

  const nodes = useMemo(() => nodesData?.nodes ?? [], [nodesData]);
  const index = useMemo(() => buildTreeIndex(nodes), [nodes]);
  const state = useExplorerState(index, filter);
  const crud = useNodeCrud(spaceId);

  const [createMode, setCreateMode] = useState<NewNodeMode | null>(null);
  const [createParent, setCreateParent] = useState<Node | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<(ContextMenuPos & { nodeId: string }) | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [transferNode, setTransferNode] = useState<Node | null>(null);

  const spaceName = spacesData?.spaces?.find((s) => s.id === spaceId)?.name ?? '空间';

  // Command palette handoffs: create-node opens the modal at root;
  // focus-node expands the ancestor chain and moves the cursor there.
  useEffect(() => {
    const onCreate = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: NewNodeMode }>).detail?.mode;
      setCreateParent(null);
      setCreateMode(mode === 'folder' ? 'folder' : 'bookmark');
    };
    window.addEventListener(CREATE_NODE_EVENT, onCreate);
    return () => window.removeEventListener(CREATE_NODE_EVENT, onCreate);
  }, []);

  const focusNodeById = useCallback(
    (nodeId: string) => {
      let parent = index.parentOf.get(nodeId);
      while (parent) {
        state.expand(parent.id);
        parent = index.parentOf.get(parent.id);
      }
      state.focusRow(nodeId);
    },
    [index, state.expand, state.focusRow],
  );

  useEffect(() => {
    const onFocus = (e: Event) => {
      consumePendingFocus(); // same-page navigation: event is enough
      const nodeId = (e as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (nodeId && index.byId.has(nodeId)) focusNodeById(nodeId);
    };
    window.addEventListener(FOCUS_NODE_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_NODE_EVENT, onFocus);
  }, [index, focusNodeById]);

  // Cross-space navigation: the target explorer mounted after the event.
  useEffect(() => {
    const pending = consumePendingFocus();
    if (pending && index.byId.has(pending)) focusNodeById(pending);
  }, [index, focusNodeById]);

  // Breadcrumb: space name plus the focused node's path to root.
  const breadcrumb = useMemo(() => {
    const parts: string[] = [];
    let cur = state.focusId ? index.byId.get(state.focusId) : undefined;
    while (cur) {
      parts.unshift(cur.title);
      cur = index.parentOf.get(cur.id) ?? undefined;
    }
    return parts.length ? [spaceName, ...parts].join(' / ') : spaceName;
  }, [state.focusId, index, spaceName]);

  // New nodes land in the explicit context-menu folder, else the single
  // selected folder, else the first root slot.
  const selectedIds = useMemo(() => [...state.selected], [state.selected]);
  const singleId = selectedIds.length === 1 ? selectedIds[0] : undefined;
  const singleSelected = singleId ? index.byId.get(singleId) : undefined;
  const selectedFolder = singleSelected?.type === 'folder' ? singleSelected : undefined;
  const effectiveParent = createParent ?? selectedFolder;
  const rootSlot = slotsData?.root_slots?.[0];
  const parentRef: ParentRef = effectiveParent
    ? { type: 'node', id: effectiveParent.id }
    : { type: 'root', key: rootSlot?.key ?? 'main' };
  const parentLabel = effectiveParent?.title ?? rootSlot?.display_name ?? '根目录';

  const closeCreate = () => {
    setCreateMode(null);
    setCreateParent(null);
  };

  const handleCreate = (values: { title: string; url?: string }) => {
    if (!createMode) return;
    const parent = effectiveParent;
    crud.create.mutate(
      { type: createMode, title: values.title, url: values.url, parent: parentRef },
      {
        onSuccess: () => {
          closeCreate();
          if (createMode === 'folder' && parent && !state.expanded.has(parent.id)) {
            state.toggleExpand(parent.id);
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

  const copyUrl = (node: Node) => {
    if (!node.url) return;
    navigator.clipboard
      .writeText(node.url)
      .then(() => notifications.show({ title: '已复制', message: node.url, color: 'healthyGreen' }))
      .catch(() => notifications.show({ title: '复制失败', message: '浏览器拒绝了剪贴板访问', color: 'errorRed' }));
  };

  const menuNode = menu ? (index.byId.get(menu.nodeId) ?? null) : null;

  return (
    <>
      <Header
        breadcrumb={breadcrumb}
        onNewBookmark={() => setCreateMode('bookmark')}
        onNewFolder={() => setCreateMode('folder')}
      />
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onImport={() => setImportOpen(true)}
        onExport={() => setExportOpen(true)}
        onCheckLinks={() => navigate(`/spaces/${spaceId}/organizer`)}
        onBackups={() => navigate(`/spaces/${spaceId}/backups`)}
      />
      <div className={contentRegion} style={{ display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {isError ? (
            <ErrorState onRetry={() => void refetch()} />
          ) : (
          <BookmarkExplorer
            isLoading={isLoading}
            index={index}
            state={state}
            renamingId={renamingId}
            onStartRename={setRenamingId}
            onCommitRename={handleCommitRename}
            onDeleteKey={() => setDeleteOpen(true)}
            onContextMenu={(x, y, id) => setMenu({ x, y, nodeId: id })}
          />
          )}
        </div>

        {inspectorOpen &&
          (singleSelected ? (
            <Inspector node={singleSelected} onClose={() => setInspectorOpen(false)} onCopyUrl={copyUrl} />
          ) : (
            <aside
              style={{
                width: tokens.inspectorWidth,
                flexShrink: 0,
                borderLeft: `1px solid ${tokens.subtleBorder}`,
                backgroundColor: tokens.workspaceBg,
                padding: '16px',
              }}
            >
              <Text fz="xs" c={tokens.textSecondary}>
                选中单个项目后查看详情。
              </Text>
            </aside>
          ))}
      </div>

      <NodeContextMenu
        pos={menu}
        node={menuNode}
        onClose={() => setMenu(null)}
        onCopyUrl={copyUrl}
        onRename={(n) => setRenamingId(n.id)}
        onCreateInside={(n, mode) => {
          setCreateParent(n);
          setCreateMode(mode);
        }}
        onDelete={() => setDeleteOpen(true)}
        onTransfer={(n) => setTransferNode(n)}
      />

      <NewNodeModal
        opened={createMode !== null}
        mode={createMode ?? 'bookmark'}
        parentLabel={parentLabel}
        pending={crud.create.isPending}
        onClose={closeCreate}
        onSubmit={handleCreate}
      />

      <ConfirmDeleteDialog
        opened={deleteOpen}
        count={deleteIds.length}
        pending={crud.remove.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
      />

      <ImportModal
        spaceId={spaceId ?? ''}
        spaceName={spaceName}
        opened={importOpen}
        onClose={() => setImportOpen(false)}
      />

      <ExportModal
        spaceId={spaceId ?? ''}
        spaceName={spaceName}
        opened={exportOpen}
        onClose={() => setExportOpen(false)}
      />

      <TransferModal
        opened={transferNode !== null}
        sourceSpaceId={spaceId ?? ''}
        node={transferNode}
        onClose={() => setTransferNode(null)}
      />
    </>
  );
}
