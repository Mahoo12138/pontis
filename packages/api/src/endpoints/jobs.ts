import { client } from '../client';
import type { JobListResponse } from '../types';

export function listJobs() {
  return client.get<JobListResponse>('/admin/jobs');
}

export function cancelJob(jobId: string) {
  return client.post<{ status: string }>(`/admin/jobs/${jobId}/cancel`, {});
}

/** Re-enqueue a failed or cancelled job (doc 13 §4.2 ops path). */
export function retryJob(jobId: string) {
  return client.post<{ id: string; type: string; status: string }>(`/admin/jobs/${jobId}/retry`, {});
}
