import { client } from '../client';
import type { RegisterDeviceRequest, RegisterDeviceResponse } from '../types';

export function registerDevice(params: RegisterDeviceRequest) {
  return client.post<RegisterDeviceResponse>('/devices', params);
}
