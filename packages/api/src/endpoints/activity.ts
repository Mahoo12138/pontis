import { client } from '../client';
import type { ActivityListResponse, UndoActivityResult } from '../types';

export function listActivity(spaceId: string) {
  return client.get<ActivityListResponse>(`/spaces/${spaceId}/activity`);
}

/**
 * Undo one ChangeSet. Resolves with the clean result; rejects with an
 * ApiError whose `details.reasons` explain review/expiry blockers
 * (REVIEW_REQUIRED, UNDO_EXPIRED, NOT_UNDOABLE, ALREADY_UNDONE).
 */
export function undoActivity(spaceId: string, changeSetId: string) {
  return client.post<UndoActivityResult>(`/spaces/${spaceId}/changesets/${changeSetId}/undo`);
}
