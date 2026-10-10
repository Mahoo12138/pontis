import { client } from '../client';
import { checkUser } from '../contract';
import type { SetupRequest, LoginRequest, LoginResponse, User } from '../types';

export function setup(params: SetupRequest) {
  return client.post<User>('/auth/setup', params, checkUser);
}

export function login(params: LoginRequest) {
  return client.post<LoginResponse>('/auth/login', params);
}

export function logout() {
  return client.post<{ status: string }>('/auth/logout');
}

/**
 * Exchange a single-use reset token for a new password. Public endpoint: the
 * caller is by definition not logged in, and the token is the credential.
 */
export function resetPassword(params: { token: string; new_password: string }) {
  return client.post<{ status: string }>('/auth/reset', params);
}

export function getMe() {
  return client.get<User>('/auth/me', checkUser);
}
