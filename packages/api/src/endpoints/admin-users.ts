import { client } from '../client';
import type { AdminUserListResponse, AdminUserView } from '../types';

export function listAdminUsers() {
  return client.get<AdminUserListResponse>('/admin/users');
}

export function setUserStatus(userId: string, status: 'active' | 'disabled') {
  return client.patch<AdminUserView>(`/admin/users/${userId}`, { status });
}

export function setUserRole(userId: string, role: 'admin' | 'user') {
  return client.patch<AdminUserView>(`/admin/users/${userId}`, { role });
}

export function createResetLink(userId: string) {
  return client.post<{ reset_link: string }>(`/admin/users/${userId}/reset-link`, {});
}
