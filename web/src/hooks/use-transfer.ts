import { useMutation } from '@tanstack/react-query';
import {
  previewImport,
  applyImport,
  exportSpace,
} from '@pontis/api/endpoints/transfer';
import type {
  ExportRequest,
  ImportApplyRequest,
  ImportPreviewRequest,
} from '@pontis/api';

export function useImportPreview(spaceId: string | undefined) {
  return useMutation({
    mutationFn: (params: ImportPreviewRequest) => previewImport(spaceId!, params),
  });
}

export function useImportApply(spaceId: string | undefined) {
  return useMutation({
    mutationFn: (params: ImportApplyRequest) => applyImport(spaceId!, params),
  });
}

export function useExport(spaceId: string | undefined) {
  return useMutation({
    mutationFn: (params: ExportRequest) => exportSpace(spaceId!, params),
  });
}
