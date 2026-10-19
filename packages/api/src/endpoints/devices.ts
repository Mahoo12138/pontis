import { client } from '../client';
import { checkDeviceOverviewResponse, checkRegisterDevice } from '../contract';
import type {
  DeviceOverviewResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
} from '../types';

export function registerDevice(params: RegisterDeviceRequest) {
  return client.post<RegisterDeviceResponse>('/devices', params, checkRegisterDevice);
}

export function listDeviceOverview() {
  return client.get<DeviceOverviewResponse>('/devices/overview', checkDeviceOverviewResponse);
}

/** Stop a device without erasing it: it stays listed as revoked until the owner
 *  deletes it. */
export function revokeDevice(deviceId: string) {
  return client.post<void>(`/devices/${deviceId}/revoke`);
}

/** Remove a revoked device's record. The server refuses a live device. */
export function deleteDevice(deviceId: string) {
  return client.delete<void>(`/devices/${deviceId}`);
}
