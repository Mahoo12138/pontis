import { client } from '../client';
import type { TransferRequest, TransferResponse } from '../types';

/** Atomic cross-space transfer within the session owner's spaces
 *  (doc 08 §15; doc 22 §5 keeps cross-user out of scope). */
export function createSpaceTransfer(sourceSpaceId: string, params: TransferRequest) {
  return client.post<TransferResponse>(`/spaces/${sourceSpaceId}/transfers`, params);
}
