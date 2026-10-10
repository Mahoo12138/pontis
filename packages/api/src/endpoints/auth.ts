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

export function getMe() {
  return client.get<User>('/auth/me', checkUser);
}
