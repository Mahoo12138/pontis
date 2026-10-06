import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  cancelMyJob,
  createSchedule,
  deleteSchedule,
  listMyTasks,
  runScheduleNow,
  updateSchedule,
} from '@pontis/api/endpoints/tasks';
import type { ScheduleRequest } from '@pontis/api';

export function useMyTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => listMyTasks(),
    refetchInterval: 5_000,
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: ScheduleRequest) => createSchedule(params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, params }: { scheduleId: string; params: ScheduleRequest }) =>
      updateSchedule(scheduleId, params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule(scheduleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useRunScheduleNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => runScheduleNow(scheduleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useCancelMyJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => cancelMyJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
