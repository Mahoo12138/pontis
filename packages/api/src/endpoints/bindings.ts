import { client } from '../client';
import { checkBinding, checkBindingList } from '../contract';
import type { BindingListResponse, CreateBindingRequest, Binding } from '../types';

export function listBindings() {
  return client.get<BindingListResponse>('/device/bindings', checkBindingList);
}

export function createBinding(params: CreateBindingRequest) {
  return client.post<Binding>('/device/bindings', params, checkBinding);
}
