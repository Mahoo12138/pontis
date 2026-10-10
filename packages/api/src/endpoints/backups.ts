import { client } from '../client';
import { checkBackup, checkBackupList } from '../contract';
import type {
  Backup,
  BackupListResponse,
  RestoreBackupResponse,
} from '../types';

export function listBackups(spaceId: string) {
  return client.get<BackupListResponse>(`/spaces/${spaceId}/backups`, checkBackupList);
}

export function createBackup(spaceId: string) {
  return client.post<Backup>(`/spaces/${spaceId}/backups`, {}, checkBackup);
}

export function restoreBackup(spaceId: string, backupId: string) {
  return client.post<RestoreBackupResponse>(`/spaces/${spaceId}/backups/${backupId}/restore`, {});
}

export function deleteBackup(spaceId: string, backupId: string) {
  return client.delete<void>(`/spaces/${spaceId}/backups/${backupId}`);
}

export function setBackupProtected(spaceId: string, backupId: string, backupProtected: boolean) {
  return client.patch<Backup>(`/spaces/${spaceId}/backups/${backupId}`, { protected: backupProtected }, checkBackup);
}
