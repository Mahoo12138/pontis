import { client } from '../client';
import type { JobListResponse } from '../types';

export function listJobs() {
  return client.get<JobListResponse>('/admin/jobs');
}

export function cancelJob(jobId: string) {
  return client.post<{ status: string }>(`/admin/jobs/${jobId}/cancel`, {});
}
