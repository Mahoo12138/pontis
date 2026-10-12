import { useQuery } from '@tanstack/react-query';
import { getMeta } from '@pontis/api/endpoints/meta';

/** Which server this browser is talking to.
 *
 * The instance id is what keeps a preference saved against one deployment
 * from being read as a preference about another one that happens to share the
 * origin (§14.1).
 */
export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: getMeta,
    // A server's identity does not change while the tab is open.
    staleTime: 600_000,
    retry: false,
  });
}
