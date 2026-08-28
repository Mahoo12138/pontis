import { useQuery } from '@tanstack/react-query';
import { listSpaces } from '@pontis/api/endpoints/spaces';
import type { SpaceListResponse } from '@pontis/api';

export function useSpaces() {
  return useQuery({
    queryKey: ['spaces'],
    queryFn: () => listSpaces(),
    staleTime: 30_000,
  });
}
