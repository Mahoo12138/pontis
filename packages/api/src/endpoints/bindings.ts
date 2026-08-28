import { client } from '../client';
import type { BindingListResponse, CreateBindingRequest, Binding } from '../types';

export function listBindings() {
  return client.get<BindingListResponse>('/device/bindings');
}

export function createBinding(params: CreateBindingRequest) {
  return client.post<Binding>('/device/bindings', params);
}
