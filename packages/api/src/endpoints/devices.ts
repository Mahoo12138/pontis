import { client } from '../client';
import type {
  DeviceOverviewResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
} from '../types';

export function registerDevice(params: RegisterDeviceRequest) {
  return client.post<RegisterDeviceResponse>('/devices', params);
}

export function listDeviceOverview() {
  return client.get<DeviceOverviewResponse>('/devices/overview');
}

export function revokeDevice(deviceId: string) {
  return client.delete<void>(`/devices/${deviceId}`);
}
