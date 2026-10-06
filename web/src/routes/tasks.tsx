import { useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  NumberInput,
  Progress,
  SegmentedControl,
  Select,
  Skeleton,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBolt,
  IconBan,
  IconDotsVertical,
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import type {
  JobStatus,
  JobType,
  ScheduleKind,
  ScheduleView,
  TaskJobView,
} from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad, rowHover } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useSpaces } from '../hooks/use-spaces';
import {
  useCancelMyJob,
  useCreateSchedule,
  useDeleteSchedule,
  useMyTasks,
  useRunScheduleNow,
  useUpdateSchedule,
} from '../hooks/use-tasks';
import { formatRelativeTime } from '../lib/format';

// ─── Presentation ────────────────────────────────────────────

// Domain names, never internal handler names (doc 13 §4.1).
const TYPE_LABEL: Record<string, string> = {
  'backup.create': '自动备份',
  'organizer.link_check': '检查失效链接',
};

const STATUS_META: Record<JobStatus, { label: string; color: string; quiet?: boolean }> = {
  queued: { label: '排队中', color: 'coolGray', quiet: true },
  running: { label: '运行中', color: 'accentBlue' },
  retry_wait: { label: '等待重试', color: 'warningAmber' },
  succeeded: { label: '成功', color: 'healthyGreen', quiet: true },
  failed: { label: '失败', color: 'errorRed' },
  cancelled: { label: '已取消', color: 'coolGray', quiet: true },
};

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function taskLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

function describeKind(s: ScheduleView): string {
  if (s.kind === 'daily') return `每天 ${s.time_of_day}`;
  if (s.kind === 'weekly') return `每${WEEKDAY_LABEL[s.weekday]} ${s.time_of_day}`;
  return `每月 ${s.day_of_month} 日 ${s.time_of_day}`;
}

export default function TasksPage() {
  const { data, isLoading, isError, refetch } = useMyTasks();
  const [createOpen, setCreateOpen] = useState(false);

  const schedules = data?.schedules ?? [];
  const jobs = data?.jobs ?? [];

  return (
    <>
      <Header breadcrumb="任务" />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group justify="space-between" mb="md">
          <Text fz={12} c="dimmed">
            任务每 5 秒自动刷新。任务配置也可以在对应功能页面创建,这里跨空间汇总管理。
          </Text>
          <Button
            size="compact-sm"
            leftSection={<IconPlus size={14} stroke={1.5} />}
            onClick={() => setCreateOpen(true)}
          >
            新建任务
          </Button>
        </Group>

        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} height={40} />
            ))}
          </div>
        ) : (
          <>
            <SchedulesSection schedules={schedules} />
            <RecentJobsSection jobs={jobs} />
          </>
        )}
      </div>

      <CreateScheduleModal opened={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

// ─── Plan schedules (doc 13 §4.1 计划任务) ───────────────────

function SchedulesSection({ schedules }: { schedules: ScheduleView[] }) {
  const toggle = useUpdateSchedule();
  const runNow = useRunScheduleNow();
  const remove = useDeleteSchedule();
  const [deleteTarget, setDeleteTarget] = useState<ScheduleView | null>(null);

  if (schedules.length === 0) {
    return (
      <Text fz={13} c="dimmed" mb="xl">
        还没有计划任务。可以从「新建任务」创建自动备份或链接检查计划。
      </Text>
    );
  }

  return (
    <Table
      verticalSpacing={9}
      horizontalSpacing={12}
      withRowBorders={false}
      mb="xl"
      styles={{
        table: { tableLayout: 'fixed' },
        th: { fontSize: 12, fontWeight: 500, color: tokens.textSecondary },
        td: { fontSize: 13 },
      }}
    >
      <Table.Thead>
        <Table.Tr>
          <Table.Th>计划任务</Table.Th>
          <Table.Th w={150}>目标空间</Table.Th>
          <Table.Th w={190}>计划</Table.Th>
          <Table.Th w={170}>下次运行</Table.Th>
          <Table.Th w={90}>状态</Table.Th>
          <Table.Th w={60} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {schedules.map((s) => (
          <Table.Tr key={s.id} className={rowHover}>
            <Table.Td>
              <Text fz={13} fw={500}>{taskLabel(s.type)}</Text>
            </Table.Td>
            <Table.Td c="dimmed" fz={12}>{s.space_name || '—'}</Table.Td>
            <Table.Td fz={12}>{describeKind(s)}</Table.Td>
            <Table.Td c="dimmed" fz={12}>
              {s.enabled ? formatRelativeTime(s.next_run_at) : '已暂停'}
              {s.last_run_at && (
                <Text fz={11} c="dimmed">上次 {formatRelativeTime(s.last_run_at)}</Text>
              )}
            </Table.Td>
            <Table.Td>
              <Badge
                size="sm"
                variant="light"
                color={s.enabled ? 'healthyGreen' : 'coolGray'}
                styles={{ root: { fontWeight: 400 } }}
              >
                {s.enabled ? '启用' : '暂停'}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Menu shadow="md" width={160} position="bottom-end">
                <Menu.Target>
                  <UnstyledButton
                    aria-label="计划任务操作"
                    style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
                  >
                    <IconDotsVertical size={16} stroke={1.5} />
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<IconBolt size={14} stroke={1.5} />}
                    disabled={!s.enabled}
                    onClick={() =>
                      runNow.mutate(s.id, {
                        onSuccess: () =>
                          notifications.show({ message: '已发起一次立即执行', color: 'coolGray' }),
                      })
                    }
                  >
                    立即运行
                  </Menu.Item>
                  <Menu.Item
                    leftSection={
                      s.enabled
                        ? <IconPlayerPause size={14} stroke={1.5} />
                        : <IconPlayerPlay size={14} stroke={1.5} />
                    }
                    onClick={() =>
                      toggle.mutate({ scheduleId: s.id, params: { enabled: !s.enabled } })
                    }
                  >
                    {s.enabled ? '暂停计划' : '恢复计划'}
                  </Menu.Item>
                  <Menu.Item
                    color="errorRed"
                    leftSection={<IconTrash size={14} stroke={1.5} />}
                    onClick={() => setDeleteTarget(s)}
                  >
                    删除计划
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`删除「${deleteTarget ? taskLabel(deleteTarget.type) : ''}」计划?`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          删除后不再产生新的计划执行;已经创建的执行会按保留策略保留,不受删除影响。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setDeleteTarget(null)}>取消</Button>
          <Button
            color="errorRed"
            loading={remove.isPending}
            onClick={() => {
              if (!deleteTarget) return;
              remove.mutate(deleteTarget.id, {
                onSuccess: () => {
                  notifications.show({ message: '计划已删除', color: 'coolGray' });
                  setDeleteTarget(null);
                },
              });
            }}
          >
            确认删除
          </Button>
        </Group>
      </Modal>
    </Table>
  );
}

// ─── Recent executions (doc 13 §4.1 最近完成 / 失败) ─────────

function RecentJobsSection({ jobs }: { jobs: TaskJobView[] }) {
  const cancel = useCancelMyJob();
  const [cancelTarget, setCancelTarget] = useState<TaskJobView | null>(null);

  if (jobs.length === 0) {
    return (
      <Text fz={13} c="dimmed">
        最近没有任务执行记录。
      </Text>
    );
  }

  return (
    <>
      <Text fz={13} fw={500} mb={4}>最近执行</Text>
      <Table
        verticalSpacing={9}
        horizontalSpacing={12}
        withRowBorders={false}
        styles={{
          table: { tableLayout: 'fixed' },
          th: { fontSize: 12, fontWeight: 500, color: tokens.textSecondary },
          td: { fontSize: 13 },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>任务</Table.Th>
            <Table.Th w={110}>状态</Table.Th>
            <Table.Th w={170}>进度</Table.Th>
            <Table.Th w={150}>目标空间</Table.Th>
            <Table.Th w={130}>时间</Table.Th>
            <Table.Th w={60} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {jobs.map((job) => {
            const status = STATUS_META[job.status];
            const active = job.status === 'running' || job.status === 'queued' || job.status === 'retry_wait';
            return (
              <Table.Tr key={job.id} className={rowHover}>
                <Table.Td>
                  <Text fz={13} fw={500}>{taskLabel(job.type)}</Text>
                  {job.error && (
                    <Text fz={12} style={{ color: tokens.syncError }} truncate>{job.error}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    {job.status === 'running' && (
                      <IconLoader2 size={13} stroke={1.5} className="spin" style={{ color: tokens.accent }} />
                    )}
                    <Badge size="sm" variant="light" color={status.color} styles={{ root: { fontWeight: 400 } }}>
                      {status.label}
                    </Badge>
                  </Group>
                </Table.Td>
                <Table.Td>
                  {job.progress && job.progress.total ? (
                    <div>
                      <Progress
                        value={(job.progress.current ?? 0) / job.progress.total * 100}
                        size={4}
                        color="accentBlue"
                        mb={4}
                      />
                      <Text fz={11} c="dimmed">
                        {job.progress.current ?? 0}/{job.progress.total}{job.phase ? ` · ${job.phase}` : ''}
                      </Text>
                    </div>
                  ) : (
                    <Text fz={12} c="dimmed" truncate>{job.phase ?? '—'}</Text>
                  )}
                </Table.Td>
                <Table.Td c="dimmed" fz={12}>{job.space_name || '—'}</Table.Td>
                <Table.Td c="dimmed" fz={12}>
                  {job.finished_at
                    ? `完成于 ${formatRelativeTime(job.finished_at)}`
                    : job.started_at
                      ? `开始于 ${formatRelativeTime(job.started_at)}`
                      : `${formatRelativeTime(job.scheduled_at)}提交`}
                </Table.Td>
                <Table.Td>
                  {active && (
                    <Menu shadow="md" width={140} position="bottom-end">
                      <Menu.Target>
                        <UnstyledButton
                          aria-label="执行操作"
                          style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
                        >
                          <IconDotsVertical size={16} stroke={1.5} />
                        </UnstyledButton>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          color="errorRed"
                          leftSection={<IconBan size={14} stroke={1.5} />}
                          onClick={() => setCancelTarget(job)}
                        >
                          取消执行
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      <Modal
        opened={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title={`取消「${cancelTarget ? taskLabel(cancelTarget.type) : ''}」执行?`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          任务会在下一个安全取消点停止,已完成的部分保留。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setCancelTarget(null)}>取消</Button>
          <Button
            color="errorRed"
            loading={cancel.isPending}
            onClick={() => {
              if (!cancelTarget) return;
              cancel.mutate(cancelTarget.id, {
                onSuccess: () => {
                  notifications.show({ message: '已请求取消', color: 'coolGray' });
                  setCancelTarget(null);
                },
              });
            }}
          >
            确认取消
          </Button>
        </Group>
      </Modal>
    </>
  );
}

// ─── Create from registered templates (doc 13 §4.1) ─────────

function CreateScheduleModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { data: spacesData } = useSpaces();
  const create = useCreateSchedule();

  const spaces = spacesData?.spaces ?? [];
  const [type, setType] = useState('backup.create');
  const [spaceId, setSpaceId] = useState<string | null>(spaces[0]?.id ?? null);
  const [kind, setKind] = useState<ScheduleKind>('daily');
  const [timeOfDay, setTimeOfDay] = useState('03:00');
  const [weekday, setWeekday] = useState<number>(1);
  const [dayOfMonth, setDayOfMonth] = useState<number>(1);

  const validTime = /^\d{2}:\d{2}$/.test(timeOfDay);

  const submit = () => {
    if (!spaceId) return;
    create.mutate(
      {
        type: type as JobType,
        kind,
        time_of_day: timeOfDay,
        weekday: kind === 'weekly' ? weekday : undefined,
        day_of_month: kind === 'monthly' ? dayOfMonth : undefined,
        // The browser timezone keeps "daily at HH:MM local" semantics; the
        // backend binds the IANA name, not a fixed UTC offset (doc 13 §6).
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        space_id: spaceId,
      },
      {
        onSuccess: () => {
          notifications.show({ message: '任务计划已创建', color: 'coolGray' });
          onClose();
        },
      },
    );
  };

  return (
    <Modal opened={opened} onClose={onClose} title="新建任务" size={440}>
      <Select
        label="任务"
        data={[
          { value: 'backup.create', label: '自动备份' },
          { value: 'organizer.link_check', label: '检查失效链接' },
        ]}
        value={type}
        onChange={(v) => v && setType(v)}
        mb="sm"
      />
      <Select
        label="目标空间"
        placeholder={spaces.length ? '选择空间' : '还没有空间'}
        data={spaces.map((s) => ({ value: s.id, label: s.name }))}
        value={spaceId}
        onChange={setSpaceId}
        mb="sm"
      />
      <SegmentedControl
        fullWidth
        value={kind}
        onChange={(v) => setKind(v as ScheduleKind)}
        data={[
          { value: 'daily', label: '每天' },
          { value: 'weekly', label: '每周' },
          { value: 'monthly', label: '每月' },
        ]}
        mb="sm"
      />
      {kind === 'weekly' && (
        <Select
          label="星期"
          data={WEEKDAY_LABEL.map((label, i) => ({ value: String(i), label }))}
          value={String(weekday)}
          onChange={(v) => v !== null && setWeekday(Number(v))}
          mb="sm"
        />
      )}
      {kind === 'monthly' && (
        <NumberInput
          label="日期(1-28)"
          min={1}
          max={28}
          value={dayOfMonth}
          onChange={(v) => typeof v === 'number' && setDayOfMonth(v)}
          mb="sm"
        />
      )}
      <TextInput
        label="时间(HH:MM,本地时间)"
        value={timeOfDay}
        onChange={(e) => setTimeOfDay(e.currentTarget.value)}
        error={timeOfDay && !validTime ? '格式应为 HH:MM' : undefined}
        mb="lg"
      />
      <Group justify="flex-end">
        <Button variant="subtle" color="coolGray" onClick={onClose}>取消</Button>
        <Button disabled={!spaceId || !validTime} loading={create.isPending} onClick={submit}>
          创建
        </Button>
      </Group>
    </Modal>
  );
}
