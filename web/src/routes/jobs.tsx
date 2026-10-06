import { useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Progress,
  Skeleton,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBan,
  IconDotsVertical,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-react';
import type { JobStatus, JobView } from '@pontis/api';
import ErrorState from '../components/common/ErrorState';
import { spin } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useCancelJob, useJobs, useRetryJob } from '../hooks/use-jobs';
import { formatRelativeTime } from '../lib/format';

const STATUS_META: Record<JobStatus, { label: string; color: string; quiet?: boolean }> = {
  queued: { label: '排队中', color: 'coolGray', quiet: true },
  running: { label: '运行中', color: 'accentBlue' },
  retry_wait: { label: '等待重试', color: 'warningAmber' },
  succeeded: { label: '成功', color: 'healthyGreen', quiet: true },
  failed: { label: '失败', color: 'errorRed' },
  cancelled: { label: '已取消', color: 'coolGray', quiet: true },
};

// Admin labels follow doc 13 §4.2: domain task names, private content
// (titles / raw URLs) never shown.
const TYPE_LABEL: Record<JobView['type'], string> = {
  'backup.create': '备份',
  'organizer.link_check': '链接检查',
  'journal.gc': '日志清理',
  'receipt.gc': '回执清理',
  'session.cleanup': '会话清理',
  'artifact.cleanup': '临时文件清理',
  'backup.retention': '备份保留策略',
  'mail.send': '邮件发送',
  'import.run': '导入',
};

export default function JobsPage() {
  const { data, isLoading, isError, refetch } = useJobs();
  const cancel = useCancelJob();
  const retry = useRetryJob();
  const [cancelTarget, setCancelTarget] = useState<JobView | null>(null);
  const [retryTarget, setRetryTarget] = useState<JobView | null>(null);

  const jobs = data?.jobs ?? [];

  return (
    <>
      <Text fz={12} c="dimmed" mb="sm">
        任务队列每 5 秒自动刷新。404 之类的链接检查结果是正常扫描结论,不会标记任务失败。
      </Text>

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={40} />
          ))}
        </div>
      ) : (
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
              <Table.Th w={110}>发起者</Table.Th>
              <Table.Th w={110}>时间</Table.Th>
              <Table.Th w={60} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onCancel={() => setCancelTarget(job)}
                onRetry={() => setRetryTarget(job)}
              />
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal
        opened={retryTarget !== null}
        onClose={() => setRetryTarget(null)}
        title={`重试「${retryTarget ? TYPE_LABEL[retryTarget.type] : ''}」任务?`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          会以相同类型重新发起一次执行，原记录保留供审计。私有内容仍然不可见。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setRetryTarget(null)}>取消</Button>
          <Button
            color="accentBlue"
            loading={retry.isPending}
            onClick={() => {
              if (!retryTarget) return;
              retry.mutate(retryTarget.id, {
                onSuccess: () => {
                  notifications.show({ message: '已重新发起任务', color: 'coolGray' });
                  setRetryTarget(null);
                },
                onError: () => {
                  notifications.show({ message: '任务当前状态不可重试', color: 'errorRed' });
                  setRetryTarget(null);
                },
              });
            }}
          >
            确认重试
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title={`取消「${cancelTarget ? TYPE_LABEL[cancelTarget.type] : ''}」任务?`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          任务会在下一个安全取消点停止,已完成的部分保留。需要改变任务语义时,取消后重新发起即可。
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
                  notifications.show({ message: '任务已请求取消', color: 'coolGray' });
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

function JobRow({ job, onCancel, onRetry }: { job: JobView; onCancel: () => void; onRetry: () => void }) {
  const status = STATUS_META[job.status];
  const active = job.status === 'running' || job.status === 'queued' || job.status === 'retry_wait';
  const retryable = job.status === 'failed' || job.status === 'cancelled';
  return (
    <Table.Tr>
      <Table.Td>
        <div style={{ minWidth: 0 }}>
          <Text fz={13} fw={500}>
            {TYPE_LABEL[job.type] ?? job.type}
            {job.attempt > 0 && job.status !== 'succeeded' && (
              <Text component="span" fz={11} c="dimmed" ml={6}>
                第 {job.attempt + 1}/{job.max_attempts} 次
              </Text>
            )}
          </Text>
          {(job.space_name || job.error) && (
            <Text fz={12} c={job.status === 'failed' ? undefined : 'dimmed'} style={{ color: job.status === 'failed' ? tokens.syncError : undefined }} truncate>
              {job.error ?? job.space_name}
            </Text>
          )}
        </div>
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          {job.status === 'running' && (
            <IconLoader2 size={13} stroke={1.5} className={spin} style={{ color: tokens.accent }} />
          )}
          <Badge size="sm" variant="light" color={status.color} styles={{ root: { fontWeight: 400 } }}>
            {status.label}
          </Badge>
        </Group>
      </Table.Td>
      <Table.Td>
        {job.progress ? (
          <div>
            <Progress value={(job.progress.current / job.progress.total) * 100} size={4} color="accentBlue" mb={4} />
            <Text fz={11} c="dimmed">
              {job.progress.current}/{job.progress.total} · {job.phase}
            </Text>
          </div>
        ) : (
          <Text fz={12} c="dimmed" truncate>{job.phase ?? '—'}</Text>
        )}
      </Table.Td>
      <Table.Td c="dimmed" fz={12}>{job.owner}</Table.Td>
      <Table.Td c="dimmed" fz={12}>
        {job.finished_at
          ? `完成于 ${formatRelativeTime(job.finished_at)}`
          : job.started_at
            ? `开始于 ${formatRelativeTime(job.started_at)}`
            : `计划于 ${formatRelativeTime(job.scheduled_at)}`}
      </Table.Td>
      <Table.Td>
        <Menu shadow="md" width={150} position="bottom-end">
          <Menu.Target>
            <UnstyledButton
              aria-label="任务操作"
              style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconRefresh size={14} stroke={1.5} />}
              disabled={!retryable}
              onClick={onRetry}
            >
              重试任务
            </Menu.Item>
            <Menu.Item
              color="errorRed"
              leftSection={<IconBan size={14} stroke={1.5} />}
              disabled={!active}
              onClick={onCancel}
            >
              取消任务
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
    </Table.Tr>
  );
}
