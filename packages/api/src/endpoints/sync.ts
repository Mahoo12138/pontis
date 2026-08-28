import { client } from '../client';
import type { SyncRequest, SyncResponse } from '../types';

export function sync(bindingId: string, params: SyncRequest) {
  return client.post<SyncResponse>(`/sync/bindings/${bindingId}`, params);
}
