import { client } from '../client';
import type { Space, SpaceListResponse, CreateSpaceRequest } from '../types';

export function listSpaces() {
  return client.get<SpaceListResponse>('/spaces');
}

export function createSpace(params: CreateSpaceRequest) {
  return client.post<Space>('/spaces', params);
}
