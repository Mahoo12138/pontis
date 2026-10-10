import { client } from '../client';
import { checkScheduleList, checkScheduleView, checkTaskList } from '../contract';
import type {
  ScheduleRequest,
  ScheduleView,
  TaskListResponse,
} from '../types';

/** User task view: own schedules plus recent own jobs (doc 13 §4.1). */
export function listMyTasks() {
  return client.get<TaskListResponse>('/tasks', checkTaskList);
}

// --- plan schedules ---

export function listSchedules() {
  return client.get<{ schedules: ScheduleView[] }>('/schedules', checkScheduleList);
}

export function createSchedule(req: ScheduleRequest) {
  return client.post<ScheduleView>('/schedules', req, checkScheduleView);
}

export function updateSchedule(scheduleId: string, req: ScheduleRequest) {
  return client.patch<ScheduleView>(`/schedules/${scheduleId}`, req, checkScheduleView);
}

export function deleteSchedule(scheduleId: string) {
  return client.delete<void>(`/schedules/${scheduleId}`);
}

/** Enqueue an immediate occurrence for a plan schedule. */
export function runScheduleNow(scheduleId: string) {
  return client.post<{ id: string; status: string }>(`/schedules/${scheduleId}/run-now`, {});
}

/** Cancel one of the caller's own jobs (doc 13 §4.1). */
export function cancelMyJob(jobId: string) {
  return client.post<{ status: string }>(`/jobs/${jobId}/cancel`, {});
}
