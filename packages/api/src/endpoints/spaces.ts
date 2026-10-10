import { client } from '../client';
import { checkSpace, checkSpaceList } from '../contract';
import type { Space, SpaceListResponse, CreateSpaceRequest } from '../types';

export function listSpaces() {
  return client.get<SpaceListResponse>('/spaces', checkSpaceList);
}

export function createSpace(params: CreateSpaceRequest) {
  return client.post<Space>('/spaces', params, checkSpace);
}
