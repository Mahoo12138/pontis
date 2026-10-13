import { client } from '../client';
import { checkAdminUserList, checkResetLink, checkUser } from '../contract';
import type { AdminCreateUserRequest, AdminUserListResponse, User } from '../types';

export function listAdminUsers() {
  return client.get<AdminUserListResponse>('/admin/users', checkAdminUserList);
}

/**
 * Create an account from the admin surface. Unlike /auth/register it does not
 * consult registration_mode — an operator adding someone is the instance
 * opting in — and the new account is always role=user with the default Space.
 */
export function createAdminUser(params: AdminCreateUserRequest) {
  return client.post<User>('/admin/users', params, checkUser);
}

// Both mutations answer with the plain user view (id, username, role, status,
// locale, created_at) — not the admin row, which adds space_count and
// last_seen_at and only the list endpoint produces.
export function setUserStatus(userId: string, status: 'active' | 'disabled') {
  return client.patch<User>(`/admin/users/${userId}`, { status }, checkUser);
}

export function setUserRole(userId: string, role: 'admin' | 'user') {
  return client.patch<User>(`/admin/users/${userId}`, { role }, checkUser);
}

export function createResetLink(userId: string) {
  return client.post<{ reset_link: string }>(
    `/admin/users/${userId}/reset-link`,
    {},
    checkResetLink,
  );
}
