import { client } from '../client';
import type { ActivityListResponse } from '../types';

export function listActivity(spaceId: string) {
  return client.get<ActivityListResponse>(`/spaces/${spaceId}/activity`);
}
