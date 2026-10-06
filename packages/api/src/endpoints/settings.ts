import { client } from '../client';
import type {
  ApiToken,
  ApiTokenListResponse,
  CreateTokenRequest,
  CreateTokenResponse,
  SystemSettings,
  SystemSettingsResponse,
  User,
} from '../types';

export function listTokens() {
  return client.get<ApiTokenListResponse>('/tokens');
}

export function createToken(params: CreateTokenRequest) {
  return client.post<CreateTokenResponse>('/tokens', params);
}

export function revokeToken(id: string) {
  return client.delete<void>(`/tokens/${id}`);
}

export function getSystemSettings() {
  return client.get<SystemSettingsResponse>('/settings');
}

export function updateSystemSettings(params: Partial<SystemSettings>) {
  return client.patch<SystemSettingsResponse>('/settings', params);
}

export function updateProfile(params: { display_name?: string; email?: string }) {
  return client.patch<User>('/auth/me', params);
}

export function changePassword(params: { current_password: string; new_password: string }) {
  return client.post<{ status: string }>('/auth/password', params);
}
