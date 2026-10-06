import { client } from '../client';
import type {
  ApplyPublicationRequest,
  ApplyPublicationResponse,
  PublicationDetail,
  PublicationListResponse,
  PublishRequest,
  PublicationSummary,
} from '../types';

export function listPlazaPublications(q?: string) {
  const path = q ? `/plaza/publications?q=${encodeURIComponent(q)}` : '/plaza/publications';
  return client.get<PublicationListResponse>(path);
}

export function getPublication(id: string) {
  return client.get<PublicationDetail>(`/publications/${id}`);
}

export function publish(params: PublishRequest) {
  return client.post<PublicationSummary>('/publications', params);
}

export function applyPublication(id: string, params: ApplyPublicationRequest) {
  return client.post<ApplyPublicationResponse>(`/publications/${id}/apply`, params);
}

export function unpublish(id: string) {
  return client.delete<void>(`/publications/${id}`);
}
