import { useQuery } from '@tanstack/react-query';
import { getExtensionDistribution } from '@pontis/api/endpoints/distribution';

export function useExtensionDistribution() {
  return useQuery({
    queryKey: ['distribution', 'extensions'],
    queryFn: () => getExtensionDistribution(),
    // This only changes when the instance is rebuilt and restarted, so the
    // install page does not need to re-ask on every mount.
    staleTime: 5 * 60_000,
  });
}
