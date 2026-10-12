import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authorizeStartPageGrant, listStartPageGrants, revokeStartPageGrant, startPageSnapshot } from '@pontis/api/endpoints/start-page';
import type { AuthorizeStartPageGrantRequest } from '@pontis/api';

/** The source folder's subtree, read as of one instant.
 *
 * Disabled until the browser has said which folder it shows: an unconfigured
 * page renders its configuration entry, and asking the server a question it
 * cannot answer would only turn the page into an error state.
 */
export function useStartPageSnapshot(spaceId: string | undefined, folderId: string | undefined) {
  return useQuery({
    queryKey: ['start-page', spaceId, folderId],
    queryFn: () => startPageSnapshot(spaceId!, folderId!),
    enabled: !!spaceId && !!folderId,
    // The page refreshes on its own cadence rather than on every focus or
    // remount; a new tab should show what is already known and update behind
    // it (§14.2).
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useStartPageGrants() {
  return useQuery({
    queryKey: ['start-page-grants'],
    queryFn: listStartPageGrants,
    staleTime: 30_000,
  });
}

export function useAuthorizeStartPageGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: AuthorizeStartPageGrantRequest) => authorizeStartPageGrant(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['start-page-grants'] });
    },
  });
}

export function useRevokeStartPageGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => revokeStartPageGrant(grantId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['start-page-grants'] });
      qc.invalidateQueries({ queryKey: ['start-page'] });
    },
  });
}
