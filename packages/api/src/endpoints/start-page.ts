import { client } from '../client';
import {
  checkStartPageGrantList,
  checkStartPageSnapshot,
  checkStartPageSource,
} from '../contract';
import type {
  AuthorizeStartPageGrantRequest,
  StartPageGrantListResponse,
  StartPageSnapshot,
  StartPageSource,
} from '../types';

// The start page's web surface (§13.1). Everything here is a session call:
// the device-facing reads belong to the extension, which authenticates as a
// device and has no business reaching through this client.

/** Approve, or move, one device's start-page source folder. */
export function authorizeStartPageGrant(params: AuthorizeStartPageGrantRequest) {
  return client.post<StartPageSource>('/start-page-grants', params, checkStartPageSource);
}

export function listStartPageGrants() {
  return client.get<StartPageGrantListResponse>('/start-page-grants', checkStartPageGrantList);
}

/** Withdraw one approval. The device keeps whatever it was already syncing. */
export function revokeStartPageGrant(grantId: string) {
  return client.delete<void>(`/start-page-grants/${grantId}`);
}

/**
 * Read one source subtree for the signed-in account. Ownership of the space
 * is the whole boundary here — a web visitor has no grant to be limited by.
 */
export function startPageSnapshot(spaceId: string, folderId: string) {
  return client.get<StartPageSnapshot>(
    `/start-page/snapshot?space_id=${encodeURIComponent(spaceId)}&folder_id=${encodeURIComponent(folderId)}`,
    checkStartPageSnapshot,
  );
}
