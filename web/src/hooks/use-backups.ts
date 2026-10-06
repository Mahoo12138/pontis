import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
  setBackupProtected,
} from '@pontis/api/endpoints/backups';

export function useBackups(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'backups'],
    queryFn: () => listBackups(spaceId!),
    enabled: !!spaceId,
    staleTime: 15_000,
  });
}

export function useCreateBackup(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => createBackup(spaceId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'backups'] }),
  });
}

export function useRestoreBackup(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => restoreBackup(spaceId!, backupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'backups'] });
    },
  });
}

export function useDeleteBackup(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => deleteBackup(spaceId!, backupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'backups'] }),
  });
}

export function useToggleBackupProtected(spaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ backupId, backupProtected }: { backupId: string; backupProtected: boolean }) =>
      setBackupProtected(spaceId!, backupId, backupProtected),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spaces', spaceId, 'backups'] }),
  });
}
