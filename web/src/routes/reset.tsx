import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Group, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { useResetPassword } from '../hooks/use-auth';
import { PontisLogo } from '../components/common/PontisLogo';

/**
 * Settle a password-reset link.
 *
 * The admin endpoint hands out `/reset?token=…`; this is the page that consumes
 * it. The token is the only credential here, and it is single-use, so a failure
 * is final for that link — the copy says so instead of offering "try again"
 * against a token the server has already spent.
 */
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const reset = useResetPassword();
  const [done, setDone] = useState(false);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <Shell>
        <Alert icon={<IconAlertCircle size={16} />} color="errorRed" variant="light">
          这个链接里没有重置凭据。请向管理员要一条完整的重置链接，或者直接登录。
        </Alert>
        <Button component={Link} to="/login" variant="light">
          去登录
        </Button>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <Group gap="xs" wrap="nowrap">
          <IconCheck size={16} style={{ color: 'var(--mantine-color-teal-6)' }} />
          <Text fz="sm">密码已更新，其它地方的登录状态都已失效。</Text>
        </Group>
        <Button onClick={() => void navigate('/login')}>用新密码登录</Button>
      </Shell>
    );
  }

  const submit = async () => {
    setError(null);
    if (password.length < 8) {
      setError('密码至少 8 个字符');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    try {
      await reset.mutateAsync({ token, new_password: password });
      setDone(true);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      setError(
        code === 'RESET_TOKEN_INVALID'
          ? '这条重置链接已经用过或已过期，需要管理员重新生成一条。'
          : ((e as Error)?.message ?? '重置失败'),
      );
    }
  };

  return (
    <Shell>
      <Stack gap="sm">
        <Text fz="sm" c="dimmed">
          为这个账户设置新密码。链接只能用一次，提交后无论成功失败都要重新生成。
        </Text>
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="errorRed" variant="light">
            {error}
          </Alert>
        )}
        <PasswordInput
          label="新密码"
          withAsterisk
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <PasswordInput
          label="确认新密码"
          withAsterisk
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
          error={confirm.length > 0 && confirm !== password ? '两次输入的密码不一致' : undefined}
        />
        <Group justify="space-between" mt="xs">
          <Button variant="subtle" color="coolGray" component={Link} to="/login">
            返回登录
          </Button>
          <Button loading={reset.isPending} onClick={() => void submit()}>
            设置新密码
          </Button>
        </Group>
      </Stack>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: 'var(--mantine-color-coolGray-0)',
        padding: 16,
      }}
    >
      <Paper shadow="sm" radius="md" p="xl" w={420} withBorder>
        <Stack gap="md">
          <Group gap="sm">
            <PontisLogo alt="Pontis" />
            <Title order={4} fw={600}>
              重置密码
            </Title>
          </Group>
          {children}
        </Stack>
      </Paper>
    </div>
  );
}
