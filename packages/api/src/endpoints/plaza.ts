import { client } from '../client';
import {
  checkApplyPublication,
  checkPlazaFacets,
  checkPublicationDetail,
  checkPublicationList,
  checkPublicationVersions,
} from '../contract';
import type {
  ApplyPublicationRequest,
  ApplyPublicationResponse,
  PlazaFacetsResponse,
  PlazaSearchParams,
  PublicationDetail,
  PublicationListResponse,
  PublicationVersionListResponse,
  PublishRequest,
  UpdatePublicationRequest,
} from '../types';

/**
 * The plaza index. Every filter is a query parameter so a searched list is a
 * link the user can share or come back to.
 */
export function listPlazaPublications(params: PlazaSearchParams = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'boolean') {
      if (value) query.set(key, '1');
      continue;
    }
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return client.get<PublicationListResponse>(
    `/plaza/publications${qs ? `?${qs}` : ''}`,
    checkPublicationList,
  );
}

export function getPlazaFacets() {
  return client.get<PlazaFacetsResponse>('/plaza/facets', checkPlazaFacets);
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
