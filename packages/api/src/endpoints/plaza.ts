import { client } from '../client';
import {
  checkApplyPublication,
  checkPublicationDetail,
  checkPublicationList,
  checkPublicationVersions,
} from '../contract';
import type {
  ApplyPublicationRequest,
  ApplyPublicationResponse,
  PublicationDetail,
  PublicationListResponse,
  PublicationVersionListResponse,
  PublishRequest,
  UpdatePublicationRequest,
} from '../types';

export function listPlazaPublications(q?: string) {
  const path = q ? `/plaza/publications?q=${encodeURIComponent(q)}` : '/plaza/publications';
  return client.get<PublicationListResponse>(path, checkPublicationList);
}

export function getPublication(id: string) {
  return client.get<PublicationDetail>(`/publications/${id}`, checkPublicationDetail);
}

// Publishing answers with the full detail (summary + tree), the same body
// GET /publications/{id} returns.
export function publish(params: PublishRequest) {
  return client.post<PublicationDetail>('/publications', params, checkPublicationDetail);
}

// A snapshot re-capture and a metadata patch share this endpoint; the server
// tells them apart by the `snapshot` flag and answers with the new detail.
export function updatePublication(id: string, params: UpdatePublicationRequest) {
  return client.patch<PublicationDetail>(`/publications/${id}`, params, checkPublicationDetail);
}

export function applyPublication(id: string, params: ApplyPublicationRequest) {
  return client.post<ApplyPublicationResponse>(
    `/publications/${id}/apply`,
    params,
    checkApplyPublication,
  );
}

// The preview runs the same copy server-side and rolls it back, so the counts
// are what an apply would report at this moment.
export function previewApplyPublication(id: string, params: ApplyPublicationRequest) {
  return client.post<ApplyPublicationResponse>(
    `/publications/${id}/apply/preview`,
    params,
    checkApplyPublication,
  );
}

export function listPublicationVersions(id: string) {
  return client.get<PublicationVersionListResponse>(
    `/publications/${id}/versions`,
    checkPublicationVersions,
  );
}

export function unpublish(id: string) {
  return client.delete<void>(`/publications/${id}`);
}
