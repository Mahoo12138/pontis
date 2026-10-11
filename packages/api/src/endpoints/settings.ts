import { client } from '../client';
import {
  checkAcknowledged,
  checkApiTokenList,
  checkCreateToken,
  checkSystemSettingsResponse,
  checkUser,
} from '../contract';
import type {
  ApiTokenListResponse,
  CreateTokenRequest,
  CreateTokenResponse,
  SystemSettingsResponse,
  UpdateSystemSettingsRequest,
  User,
} from '../types';

export function listTokens() {
  return client.get<ApiTokenListResponse>('/tokens', checkApiTokenList);
}

// The secret is present exactly once, in this answer; the list never carries it.
export function createToken(params: CreateTokenRequest) {
  return client.post<CreateTokenResponse>('/tokens', params, checkCreateToken);
}

export function revokeToken(id: string) {
  return client.delete<void>(`/tokens/${id}`);
}

export function getSystemSettings() {
  return client.get<SystemSettingsResponse>('/settings', checkSystemSettingsResponse);
}

export function updateSystemSettings(params: UpdateSystemSettingsRequest) {
  return client.patch<SystemSettingsResponse>('/settings', params, checkSystemSettingsResponse);
}

export function updateProfile(params: { display_name?: string; email?: string }) {
  return client.patch<User>('/auth/me', params, checkUser);
}

export function changePassword(params: { current_password: string; new_password: string }) {
  return client.post<{ status: string }>('/auth/password', params, checkAcknowledged);
}
