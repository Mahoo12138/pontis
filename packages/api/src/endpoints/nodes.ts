import { client } from '../client';
import type {
  Node,
  NodeListResponse,
  RootSlotListResponse,
  CreateNodeRequest,
  UpdateNodeRequest,
  MoveNodeRequest,
} from '../types';

/** List all nodes in a space (gap endpoint — mock only). */
export function listNodes(spaceId: string) {
  return client.get<NodeListResponse>(`/spaces/${spaceId}/nodes`);
}

/** List root slots for a space (gap endpoint — mock only). */
export function listRootSlots(spaceId: string) {
  return client.get<RootSlotListResponse>(`/spaces/${spaceId}/root-slots`);
}

/** Create a node (gap endpoint — mock only). */
export function createNode(spaceId: string, params: CreateNodeRequest) {
  return client.post<Node>(`/spaces/${spaceId}/nodes`, params);
}

/** Update a node's title or URL (gap endpoint — mock only). */
export function updateNode(spaceId: string, nodeId: string, params: UpdateNodeRequest) {
  return client.patch<Node>(`/spaces/${spaceId}/nodes/${nodeId}`, params);
}

/** Move a node (gap endpoint — mock only). */
export function moveNode(spaceId: string, nodeId: string, params: MoveNodeRequest) {
  return client.patch<Node>(`/spaces/${spaceId}/nodes/${nodeId}/move`, params);
}

/** Delete a node (gap endpoint — mock only). */
export function deleteNode(spaceId: string, nodeId: string) {
  return client.delete<void>(`/spaces/${spaceId}/nodes/${nodeId}`);
}
