import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelJob, listJobs, retryJob } from '@pontis/api/endpoints/jobs';

export function useJobs() {
  return useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => listJobs(),
    refetchInterval: 5_000,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => cancelJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'jobs'] }),
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => retryJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'jobs'] }),
  });
}
