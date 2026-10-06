import { client } from '../client';
import type {
  DuplicatesResponse,
  LinkCheckResultsResponse,
  LinkCheckRunResponse,
} from '../types';

export function runLinkCheck(spaceId: string) {
  return client.post<LinkCheckRunResponse>(`/spaces/${spaceId}/organizer/link-check`, {});
}

export function listLinkCheckResults(spaceId: string) {
  return client.get<LinkCheckResultsResponse>(`/spaces/${spaceId}/organizer/link-check/results`);
}

export function listDuplicates(spaceId: string) {
  return client.get<DuplicatesResponse>(`/spaces/${spaceId}/organizer/duplicates`);
}
