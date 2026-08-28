import { client } from '../client';
import type { MetaResponse } from '../types';

export function getMeta() {
  return client.get<MetaResponse>('/meta');
}
