import { client } from '../client';
import type {
  ExportRequest,
  ExportResponse,
  ImportApplyRequest,
  ImportApplyResponse,
  ImportPlan,
  ImportPreviewRequest,
} from '../types';

export function previewImport(spaceId: string, params: ImportPreviewRequest) {
  return client.post<ImportPlan>(`/spaces/${spaceId}/import/preview`, params);
}

export function applyImport(spaceId: string, params: ImportApplyRequest) {
  return client.post<ImportApplyResponse>(`/spaces/${spaceId}/import/apply`, params);
}

export function exportSpace(spaceId: string, params: ExportRequest) {
  return client.post<ExportResponse>(`/spaces/${spaceId}/export`, params);
}
