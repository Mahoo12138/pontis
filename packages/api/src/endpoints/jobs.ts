import { client } from '../client';
import { checkAcknowledged, checkJobAccepted, checkJobList } from '../contract';
import type { JobListResponse, JobStatus, JobType } from '../types';

export function listJobs() {
  return client.get<JobListResponse>('/admin/jobs', checkJobList);
}

export function cancelJob(jobId: string) {
  return client.post<{ status: string }>(`/admin/jobs/${jobId}/cancel`, {}, checkAcknowledged);
}

/** Re-enqueue a failed or cancelled job (doc 13 §4.2 ops path). */
export function retryJob(jobId: string) {
  return client.post<{ id: string; type: JobType; status: JobStatus }>(
    `/admin/jobs/${jobId}/retry`,
    {},
    checkJobAccepted,
  );
}
