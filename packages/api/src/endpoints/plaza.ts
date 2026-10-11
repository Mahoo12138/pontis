import { client } from '../client';
import {
  checkApplyPublication,
  checkPublicationDetail,
  checkPublicationList,
} from '../contract';
import type {
  ApplyPublicationRequest,
  ApplyPublicationResponse,
  PublicationDetail,
  PublicationListResponse,
  PublishRequest,
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

export function applyPublication(id: string, params: ApplyPublicationRequest) {
  return client.post<ApplyPublicationResponse>(
    `/publications/${id}/apply`,
    params,
    checkApplyPublication,
  );
}

export function unpublish(id: string) {
  return client.delete<void>(`/publications/${id}`);
}
