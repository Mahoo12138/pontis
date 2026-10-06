import { client } from '../client';
import type { ActivityListResponse, UndoResponse } from '../types';

export function listActivity(spaceId: string) {
  return client.get<ActivityListResponse>(`/spaces/${spaceId}/activity`);
}

/** Applies the inverse of one ChangeSet as a new ChangeSet (doc 15). */
export function undoActivity(spaceId: string, changeSetId: string) {
  return client.post<UndoResponse>(`/spaces/${spaceId}/activity/${changeSetId}/undo`);
}
