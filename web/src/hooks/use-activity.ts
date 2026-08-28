import { useQuery } from '@tanstack/react-query';
import { listActivity } from '@pontis/api/endpoints/activity';

export function useActivity(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'activity'],
    queryFn: () => listActivity(spaceId!),
    enabled: !!spaceId,
    staleTime: 30_000,
  });
}
