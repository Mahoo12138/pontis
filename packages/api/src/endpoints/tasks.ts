import { client } from '../client';
import type {
  ScheduleRequest,
  ScheduleView,
  TaskListResponse,
} from '../types';

/** User task view: own schedules plus recent own jobs (doc 13 §4.1). */
export function listMyTasks() {
  return client.get<TaskListResponse>('/tasks');
}

// --- plan schedules ---

export function listSchedules() {
  return client.get<{ schedules: ScheduleView[] }>('/schedules');
}

export function createSchedule(req: ScheduleRequest) {
  return client.post<ScheduleView>('/schedules', req);
}

export function updateSchedule(scheduleId: string, req: ScheduleRequest) {
  return client.patch<ScheduleView>(`/schedules/${scheduleId}`, req);
}

export function deleteSchedule(scheduleId: string) {
  return client.delete<void>(`/schedules/${scheduleId}`);
}

/** Enqueue an immediate occurrence for a plan schedule. */
export function runScheduleNow(scheduleId: string) {
  return client.post<{ id: string; status: string }>(`/schedules/${scheduleId}/run-now`, {});
}
