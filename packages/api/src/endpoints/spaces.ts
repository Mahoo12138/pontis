import { client } from '../client';
import { checkSpace, checkSpaceList } from '../contract';
import type { Space, SpaceListResponse, CreateSpaceRequest } from '../types';

export function listSpaces() {
  return client.get<SpaceListResponse>('/spaces', checkSpaceList);
}

export function createSpace(params: CreateSpaceRequest) {
  return client.post<Space>('/spaces', params, checkSpace);
}

/** Rename a space. The server answers 204, so there is no body to check. */
export function renameSpace(id: string, params: CreateSpaceRequest) {
  return client.patch<void>(`/spaces/${encodeURIComponent(id)}`, params);
}

/** Delete a space. Only an empty one is deleted; otherwise 409 SPACE_NOT_EMPTY. */
export function deleteSpace(id: string) {
  return client.delete<void>(`/spaces/${encodeURIComponent(id)}`);
}
