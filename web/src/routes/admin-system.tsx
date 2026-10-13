import { NativeSelect, SegmentedControl, Skeleton, Text } from '@mantine/core';
import ErrorState from '../components/common/ErrorState';
import { sectionTitle, sectionHint } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useSystemSettings, useUpdateSystemSettings } from '../hooks/use-settings';

// Instance-level policy configuration only (CHANGELOG v1.2). User and job
// management live in their own admin tabs, not as settings items.
//
// A control is disabled while no server code acts on its key, and its NotLive
// note says what is missing: the server stores every value here and echoes it
// back, so an accepted PATCH that changes no behaviour is how an operator
// learns to distrust this page. They become enabled together with the code that
// enforces them.
export default function AdminSystemPage() {
  const { data, isLoading, isError, error, refetch } = useSystemSettings();
  const update = useUpdateSystemSettings();

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton height={200} />;

  const s = data?.settings;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 480 }}>
      <section>
        <Text className={sectionTitle} mb={4}>注册模式</Text>
        <Text className={sectionHint} mb="sm">
          closed 仅允许已有用户登录;open 在登录页开放注册入口;invite 暂按 closed 处理。
        </Text>
        <SegmentedControl
          w={280}
          value={s?.registration_mode ?? 'closed'}
          onChange={(v) => update.mutate({ registration_mode: v as 'closed' | 'open' | 'invite' })}
          data={[
            { label: '关闭', value: 'closed' },
            { label: '开放', value: 'open' },
            { label: '邀请(预留)', value: 'invite' },
          ]}
          styles={{ root: { backgroundColor: tokens.hoverBg } }}
        />
      </section>
      <section>
        <Text className={sectionTitle} mb={4}>会话有效期</Text>
        <NativeSelect
          disabled
          w={220}
          value={s?.session_ttl_hours ?? '24'}
          data={[
            { value: '12', label: '12 小时' },
            { value: '24', label: '24 小时' },
            { value: '168', label: '7 天' },
            { value: '720', label: '30 天' },
          ]}
          onChange={(e) => update.mutate({ session_ttl_hours: Number(e.currentTarget.value) })}
        />
        <NotLive reason="有效期是服务端常量，改动不会让已签发的会话提前或延后过期。" />
      </section>
      <section>
        <Text className={sectionTitle} mb={4}>每用户空间上限</Text>
        <NativeSelect
          disabled
          w={220}
          value={s?.max_spaces_per_user ?? '16'}
          data={['4', '8', '16', '32', '64'].map((v) => ({ value: v, label: `${v} 个` }))}
          onChange={(e) => update.mutate({ max_spaces_per_user: Number(e.currentTarget.value) })}
        />
        <NotLive reason="创建 Space 时不校验数量，这个上限不会拒绝任何请求。" />
      </section>
    </div>
  );
}

function NotLive({ reason }: { reason: string }) {
  return (
    <Text mt={6} size="xs" c={tokens.textSecondary}>
      当前不生效：{reason}
    </Text>
  );
}
