import { client } from '../client';
import { checkAcknowledged, checkLogin, checkSystemStatus, checkUser } from '../contract';
import type {
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  SetupRequest,
  SystemStatusResponse,
  User,
} from '../types';

export function setup(params: SetupRequest) {
  return client.post<User>('/auth/setup', params, checkUser);
}

/**
 * Create an ordinary account on an instance that has opted into open
 * registration. Public — the caller has no session by definition — and refused
 * when the instance has no admin yet, so it is never a path to the admin role.
 */
export function register(params: RegisterRequest) {
  return client.post<User>('/auth/register', params, checkUser);
}

/**
 * The instance's public state, readable without a session. This is what a
 * guard asks before deciding between /login, /register and /setup; the
 * authenticated settings surface (/settings) cannot answer for a visitor.
 */
export function getSystemStatus() {
  return client.get<SystemStatusResponse>('/system/status', checkSystemStatus);
}

export function login(params: LoginRequest) {
  return client.post<LoginResponse>('/auth/login', params, checkLogin);
}

export function logout() {
  return client.post<{ status: string }>('/auth/logout', undefined, checkAcknowledged);
}

/**
 * Exchange a single-use reset token for a new password. Public endpoint: the
 * caller is by definition not logged in, and the token is the credential.
 */
export function resetPassword(params: { token: string; new_password: string }) {
  return client.post<{ status: string }>('/auth/reset', params, checkAcknowledged);
}

export function getMe() {
  return client.get<User>('/auth/me', checkUser);
}
