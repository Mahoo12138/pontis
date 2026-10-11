import { client } from '../client';
import {
  checkDuplicates,
  checkLinkCheckResults,
  checkLinkDeletion,
} from '../contract';
import type {
  DuplicatesResponse,
  LinkCheckResultsResponse,
  LinkCheckRunResponse,
  LinkDeletionResponse,
} from '../types';

export function runLinkCheck(spaceId: string) {
  return client.post<LinkCheckRunResponse>(`/spaces/${spaceId}/organizer/link-check`, {});
}

export function listLinkCheckResults(spaceId: string) {
  return client.get<LinkCheckResultsResponse>(
    `/spaces/${spaceId}/organizer/link-check/results`,
    checkLinkCheckResults,
  );
}

/**
 * Delete findings of one run. The server re-checks each node against the URL
 * that was actually scanned, so the answer names what it refused as well as
 * what it removed.
 */
export function deleteBrokenLinks(spaceId: string, params: { job_id: string; node_ids: string[] }) {
  return client.post<LinkDeletionResponse>(
    `/spaces/${spaceId}/organizer/link-check/delete`,
    params,
    checkLinkDeletion,
  );
}

export function listDuplicates(spaceId: string) {
  return client.get<DuplicatesResponse>(`/spaces/${spaceId}/organizer/duplicates`, checkDuplicates);
}
