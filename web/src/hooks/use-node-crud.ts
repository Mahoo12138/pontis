import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  createNode,
  updateNode,
  moveNode,
  deleteNode,
} from '@pontis/api/endpoints/nodes';
import type {
  CreateNodeRequest,
  UpdateNodeRequest,
  MoveNodeRequest,
} from '@pontis/api';

/**
 * TanStack Query mutations for node CRUD against the (gap) endpoints.
 * Every success invalidates the space's node list so the explorer,
 * breadcrumbs and inspector re-derive from fresh server state.
 */
export function useNodeCrud(spaceId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'nodes'] });
  };
  const onError = (e: unknown) => {
    notifications.show({
      color: 'errorRed',
      title: '操作失败',
      message: e instanceof Error ? e.message : '请稍后重试',
    });
  };

  const create = useMutation({
    mutationFn: (params: CreateNodeRequest) => createNode(spaceId!, params),
    onSuccess: invalidate,
    onError,
  });

  const update = useMutation({
    mutationFn: ({ nodeId, params }: { nodeId: string; params: UpdateNodeRequest }) =>
      updateNode(spaceId!, nodeId, params),
    onSuccess: invalidate,
    onError,
  });

  const move = useMutation({
    mutationFn: ({ nodeId, params }: { nodeId: string; params: MoveNodeRequest }) =>
      moveNode(spaceId!, nodeId, params),
    onSuccess: invalidate,
    onError,
  });

  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await deleteNode(spaceId!, id);
    },
    onSuccess: invalidate,
    onError,
  });

  return { create, update, move, remove };
}

export type NodeCrud = ReturnType<typeof useNodeCrud>;
