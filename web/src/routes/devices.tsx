import { useState } from 'react';
import {
  Badge,
  Button,
  CopyButton,
  Group,
  Menu,
  Modal,
  Skeleton,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBrandChrome,
  IconBrandEdge,
  IconBrandFirefox,
  IconBrandSafari,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconCheck,
  IconDeviceDesktop,
  IconDotsVertical,
  IconPlus,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import type { BindingHealth, DeviceBindingView, DeviceOverview } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { contentRegion } from '../styles/app-shell.css';
import {
  pagePad,
  mono,
  statusDot,
  statusDotPulsing,
  rowHover,
  detailRow,
} from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import {
  useDeviceOverview,
  useRegisterDevice,
  useRevokeDevice,
} from '../hooks/use-devices';
import { formatRelativeTime } from '../lib/format';

// ─── Status presentation ─────────────────────────────────────

interface HealthMeta {
  label: string;
  color: string;
  pulse?: boolean;
  quiet?: boolean;
}

const HEALTH_META: Record<BindingHealth, HealthMeta> = {
  healthy: { label: '已同步', color: tokens.syncHealthy, quiet: true },
  syncing: { label: '同步中', color: tokens.accent, pulse: true },
  warning: { label: '待处理', color: tokens.syncWarning },
  recovery: { label: '需要恢复', color: tokens.syncRecovery },
  offline: { label: '离线', color: tokens.textDisabled },
  suspended: { label: '已暂停', color: tokens.textDisabled },
};

/** A device is only as healthy as its worst binding; normal states stay quiet. */
const SEVERITY: BindingHealth[] = [
  'recovery',
  'warning',
  'offline',
  'suspended',
  'syncing',
  'healthy',
];

function deviceHealth(device: DeviceOverview): BindingHealth | null {
  let worst: BindingHealth | null = null;
  for (const b of device.bindings) {
    if (worst === null || SEVERITY.indexOf(b.health) < SEVERITY.indexOf(worst)) {
      worst = b.health;
    }
  }
  return worst;
}

function StatusCell({ health }: { health: BindingHealth | null }) {
  if (!health) {
    return (
      <Group gap={6} wrap="nowrap">
        <span className={statusDot} style={{ backgroundColor: tokens.textDisabled }} />
        <Text fz={13} c="dimmed">未绑定</Text>
      </Group>
    );
  }
  const meta = HEALTH_META[health];
  return (
    <Group gap={6} wrap="nowrap">
      <span
        className={`${statusDot} ${meta.pulse ? statusDotPulsing : ''}`}
        style={{ backgroundColor: meta.color }}
      />
      <Text fz={13} c={meta.quiet ? 'dimmed' : undefined} style={{ color: meta.quiet ? undefined : meta.color }}>
        {meta.label}
      </Text>
    </Group>
  );
}

// ─── Device identity presentation ────────────────────────────

const BROWSER_ICON: Record<string, typeof IconDeviceDesktop> = {
  chrome: IconBrandChrome,
  edge: IconBrandEdge,
  firefox: IconBrandFirefox,
  safari: IconBrandSafari,
};

const PLATFORM_LABEL: Record<string, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
};

const MODE_LABEL: Record<string, string> = {
  full: '整体同步',
  partial: '部分同步',
};

function DeviceName({ device }: { device: DeviceOverview }) {
  const BrowserIcon = BROWSER_ICON[device.browser] ?? IconDeviceDesktop;
  const platform = PLATFORM_LABEL[device.platform] ?? device.platform;
  return (
    <Group gap={8} wrap="nowrap">
      <BrowserIcon size={16} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <Text fz={13} fw={500} truncate="end">{device.name}</Text>
        <Text fz={12} c="dimmed">{platform || '未知平台'}</Text>
      </div>
    </Group>
  );
}

// ─── Page ─────────────────────────────────────────────────────

export default function DevicesPage() {
  const { data, isLoading, isError, refetch } = useDeviceOverview();
  const register = useRegisterDevice();
  const revoke = useRevokeDevice();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<DeviceOverview | null>(null);

  const devices = data?.devices ?? [];

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRevoke = () => {
    if (!revokeTarget) return;
    revoke.mutate(revokeTarget.id, {
      onSuccess: () => {
        notifications.show({
          message: `已撤销「${revokeTarget.name}」,该设备不再同步`,
          color: 'coolGray',
        });
        setRevokeTarget(null);
      },
      onError: (e) =>
        notifications.show({
          message: e instanceof Error ? e.message : '撤销失败',
          color: 'errorRed',
        }),
    });
  };

  return (
    <>
      <Header breadcrumb="设备" primaryAction={{ label: '添加设备', icon: <IconPlus size={14} stroke={1.5} />, onClick: () => setAddOpen(true) }} />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group justify="space-between" mb="sm">
          <Text fz={13} c="dimmed">
            设备是浏览器 Profile 中的一次扩展安装。每个设备可以绑定一个或多个同步空间。
          </Text>
        </Group>

        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={44} />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <EmptyDevices onAdd={() => setAddOpen(true)} />
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
                <Table.Th w={44} />
                <Table.Th>设备</Table.Th>
                <Table.Th w={110}>模式</Table.Th>
                <Table.Th>绑定空间</Table.Th>
                <Table.Th w={130}>状态</Table.Th>
                <Table.Th w={120}>最后活动</Table.Th>
                <Table.Th w={60} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  expanded={expanded.has(device.id)}
                  onToggle={() => toggleExpand(device.id)}
                  onRevoke={() => setRevokeTarget(device)}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </div>

      <AddDeviceModal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        registering={register.isPending}
        onRegister={(name) =>
          new Promise((resolve, reject) =>
            register.mutate(
              { name, client_type: 'extension' },
              { onSuccess: resolve, onError: (e) => reject(e instanceof Error ? e : new Error('注册失败')) },
            ),
          )
        }
      />

      <Modal
        opened={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={revokeTarget ? `撤销「${revokeTarget.name}」？` : ''}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          此设备将立即失去同步权限,设备上的本地书签不会被删除。
          如需恢复同步,需要在该设备上重新注册。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setRevokeTarget(null)}>
            取消
          </Button>
          <Button color="errorRed" loading={revoke.isPending} onClick={handleRevoke}>
            撤销设备
          </Button>
        </Group>
      </Modal>
    </>
  );
}

// ─── Table row ────────────────────────────────────────────────

function DeviceRow({
  device,
  expanded,
  onToggle,
  onRevoke,
}: {
  device: DeviceOverview;
  expanded: boolean;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const hasBindings = device.bindings.length > 0;
  return (
    <>
      <Table.Tr className={rowHover}>
        <Table.Td>
          {hasBindings && (
            <UnstyledButton
              onClick={onToggle}
              aria-label={expanded ? '收起绑定详情' : '展开绑定详情'}
              aria-expanded={expanded}
              style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 2 }}
            >
              {expanded ? (
                <IconChevronDown size={14} stroke={1.7} />
              ) : (
                <IconChevronRight size={14} stroke={1.7} />
              )}
            </UnstyledButton>
          )}
        </Table.Td>
        <Table.Td><DeviceName device={device} /></Table.Td>
        <Table.Td>
          <Text fz={13} c={device.sync_mode ? undefined : 'dimmed'}>
            {MODE_LABEL[device.sync_mode] ?? '—'}
          </Text>
        </Table.Td>
        <Table.Td>
          {hasBindings ? (
            <Group gap={4}>
              {device.bindings.map((b) => (
                <Badge
                  key={b.id}
                  variant="light"
                  color="coolGray"
                  styles={{ root: { fontWeight: 400 } }}
                >
                  {b.space_name}
                </Badge>
              ))}
            </Group>
          ) : (
            <Text fz={13} c="dimmed">—</Text>
          )}
        </Table.Td>
        <Table.Td><StatusCell health={deviceHealth(device)} /></Table.Td>
        <Table.Td c="dimmed" fz={12}>
          {device.last_seen_at ? formatRelativeTime(device.last_seen_at) : '从未连接'}
        </Table.Td>
        <Table.Td>
          <Menu shadow="md" width={160} position="bottom-end">
            <Menu.Target>
              <UnstyledButton
                aria-label="设备操作"
                style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4, borderRadius: 4 }}
              >
                <IconDotsVertical size={16} stroke={1.5} />
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconShieldOff size={14} stroke={1.5} />}
                disabled={!hasBindings}
              >
                暂停同步
              </Menu.Item>
              <Menu.Item
                color="errorRed"
                leftSection={<IconTrash size={14} stroke={1.5} />}
                onClick={onRevoke}
              >
                撤销此设备
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Table.Td>
      </Table.Tr>
      {expanded &&
        device.bindings.map((binding) => (
          <BindingDetailRow key={binding.id} binding={binding} />
        ))}
    </>
  );
}

function BindingDetailRow({ binding }: { binding: DeviceBindingView }) {
  const meta = HEALTH_META[binding.health];
  return (
    <Table.Tr className={detailRow}>
      <Table.Td />
      <Table.Td colSpan={3} py={7}>
        <Group gap={10} wrap="nowrap">
          <span
            className={`${statusDot} ${meta.pulse ? statusDotPulsing : ''}`}
            style={{ backgroundColor: meta.color, width: 6, height: 6 }}
          />
          <Text fz={13}>{binding.space_name}</Text>
          <Text fz={12} c="dimmed">
            {binding.sync_mode === 'full' ? '整体' : '部分'} · {binding.state === 'active' ? '活跃' : binding.state === 'suspended' ? '已暂停' : '等待初始同步'}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td py={7}>
        <Tooltip
          label={`Epoch ${binding.epoch}`}
          withArrow
          position="top"
        >
          <span className={mono} style={{ color: tokens.textSecondary }}>
            {binding.applied_revision} → {binding.server_revision}
          </span>
        </Tooltip>
      </Table.Td>
      <Table.Td py={7} fz={12} c="dimmed">
        {binding.last_sync_at ? formatRelativeTime(binding.last_sync_at) : '—'}
      </Table.Td>
      <Table.Td />
    </Table.Tr>
  );
}

// ─── Add device flow ──────────────────────────────────────────

interface RegisterResult {
  device: { id: string; name: string };
  token: string;
}

function AddDeviceModal({
  opened,
  onClose,
  registering,
  onRegister,
}: {
  opened: boolean;
  onClose: () => void;
  registering: boolean;
  onRegister: (name: string) => Promise<RegisterResult>;
}) {
  const [step, setStep] = useState<'form' | 'secret'>('form');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterResult | null>(null);

  const reset = () => {
    setStep('form');
    setName('');
    setNameError(null);
    setResult(null);
  };

  const close = () => {
    onClose();
    // Keep the modal contents until the fade-out finishes.
    window.setTimeout(reset, 200);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1) {
      setNameError('设备名称不能为空');
      return;
    }
    try {
      const res = await onRegister(trimmed);
      setResult(res);
      setStep('secret');
    } catch (e) {
      setNameError(e instanceof Error ? e.message : '注册失败');
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={step === 'form' ? '添加设备' : '设备密钥'}
      size={440}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      {step === 'form' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextInput
            label="设备名称"
            description="建议使用「浏览器 + 平台」格式,例如 Edge on MacBook"
            placeholder="Edge on MacBook"
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setNameError(null);
            }}
            error={nameError ?? undefined}
            data-autofocus
          />
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={close}>
              取消
            </Button>
            <Button type="submit" loading={registering}>
              注册
            </Button>
          </Group>
        </form>
      ) : (
        <div>
          <Text fz={13}>
            在「{result?.device.name}」上的 Pontis 扩展中输入此密钥完成绑定。
            <strong style={{ fontWeight: 600 }}>此密钥只显示一次</strong>,关闭后将无法再次查看。
          </Text>
          <div
            className={mono}
            style={{
              marginTop: 12,
              padding: '10px 12px',
              backgroundColor: tokens.raisedBg,
              border: `1px solid ${tokens.subtleBorder}`,
              borderRadius: 6,
              wordBreak: 'break-all',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <span style={{ flex: 1 }}>{result?.token}</span>
            <CopyButton value={result?.token ?? ''}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? '已复制' : '复制'} withArrow>
                  <UnstyledButton
                    onClick={copy}
                    aria-label="复制密钥"
                    style={{ color: copied ? tokens.syncHealthy : tokens.textSecondary, display: 'inline-flex' }}
                  >
                    {copied ? <IconCheck size={15} stroke={1.7} /> : <IconCopy size={15} stroke={1.5} />}
                  </UnstyledButton>
                </Tooltip>
              )}
            </CopyButton>
          </div>
          <Group justify="flex-end" mt="lg">
            <Button onClick={close}>我已保存密钥</Button>
          </Group>
        </div>
      )}
    </Modal>
  );
}

function EmptyDevices({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 260,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <IconDeviceDesktop size={32} stroke={1.2} />
      <Text fz="sm">还没有注册任何设备</Text>
      <Text fz="xs" c="dimmed">
        在浏览器中安装 Pontis 扩展并注册后,即可开始同步书签。
      </Text>
      <Button size="compact-sm" variant="subtle" onClick={onAdd} mt={4} leftSection={<IconPlus size={14} stroke={1.5} />}>
        添加设备
      </Button>
    </div>
  );
}
