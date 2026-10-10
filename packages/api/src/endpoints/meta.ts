import { client } from '../client';
import { checkMeta } from '../contract';
import type { MetaResponse } from '../types';

export function getMeta() {
  return client.get<MetaResponse>('/meta', checkMeta);
}
