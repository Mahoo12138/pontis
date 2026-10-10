import { client } from '../client';
import { checkNode, checkNodeList, checkRootSlotList } from '../contract';
import type {
  Node,
  NodeListResponse,
  RootSlotListResponse,
  CreateNodeRequest,
  UpdateNodeRequest,
  MoveNodeRequest,
} from '../types';

export function listNodes(spaceId: string) {
  return client.get<NodeListResponse>(`/spaces/${spaceId}/nodes`, checkNodeList);
}

export function listRootSlots(spaceId: string) {
  return client.get<RootSlotListResponse>(`/spaces/${spaceId}/root-slots`, checkRootSlotList);
}

export function createNode(spaceId: string, params: CreateNodeRequest) {
  return client.post<Node>(`/spaces/${spaceId}/nodes`, params, checkNode);
}

/** Update a node's title or URL. */
export function updateNode(spaceId: string, nodeId: string, params: UpdateNodeRequest) {
  return client.patch<Node>(`/spaces/${spaceId}/nodes/${nodeId}`, params, checkNode);
}

export function moveNode(spaceId: string, nodeId: string, params: MoveNodeRequest) {
  return client.patch<Node>(`/spaces/${spaceId}/nodes/${nodeId}/move`, params, checkNode);
}

export function deleteNode(spaceId: string, nodeId: string) {
  return client.delete<void>(`/spaces/${spaceId}/nodes/${nodeId}`);
}
