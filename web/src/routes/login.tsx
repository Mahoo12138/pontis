import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { TextInput, PasswordInput, Button, Group, Stack, Paper, Text, Alert, Anchor } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle, IconCircleCheck } from '@tabler/icons-react';
import { useLogin, useSystemStatus } from '../hooks/use-auth';
import { PontisLogo } from '../components/common/PontisLogo';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const loginMutation = useLogin();
  const { data: status } = useSystemStatus();
  const [error, setError] = useState<string | null>(null);

  // Registration is offered only on a confirmed `open`; the bootstrap link
  // stays until the instance is confirmed initialized. The asymmetry is
  // deliberate: a status read that fails must never strand a fresh install
  // with no way in, and must never grant more access than it can confirm.
  const allowRegistration = status?.allow_registration ?? false;
  const showSetupLink = !status?.initialized;

  const form = useForm({
    initialValues: { username: '', password: '' },
    validate: {
      username: (v) => (v.trim().length === 0 ? '请输入用户名' : null),
      password: (v) => (v.length === 0 ? '请输入密码' : null),
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    try {
      await loginMutation.mutateAsync(values);
      navigate('/');
    } catch (e: any) {
      setError(e?.message ?? '登录失败');
    }
  });

  const justRegistered = Boolean((location.state as { registered?: boolean } | null)?.registered);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      backgroundColor: 'var(--mantine-color-coolGray-0)',
    }}>
      <Paper shadow="sm" radius="md" p="xl" w={400}>
        <Stack gap="md">
          <Group gap="sm">
            <PontisLogo />
            <Text fz="lg" fw={600}>Pontis</Text>
          </Group>
          <Text fz="sm" c="dimmed">登录到你的书签工作空间</Text>

          {justRegistered && (
            <Alert icon={<IconCircleCheck size={16} />} color="healthyGreen" variant="light">
              账号已创建，用刚才的用户名登录。
            </Alert>
          )}

          {error && (
            <Alert icon={<IconAlertCircle size={16} />} color="errorRed" variant="light">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            <Stack gap="sm">
              <TextInput
                label="用户名"
                placeholder="admin"
                {...form.getInputProps('username')}
              />
              <PasswordInput
                label="密码"
                placeholder="输入密码"
                {...form.getInputProps('password')}
              />
              <Button type="submit" loading={loginMutation.isPending} fullWidth mt="xs">
                登录
              </Button>
            </Stack>
          </form>

          {allowRegistration && (
            <Text fz="xs" c="dimmed" ta="center">
              还没有账号？<Anchor fz="xs" component={Link} to="/register">创建账号</Anchor>
            </Text>
          )}
          {showSetupLink && (
            <Text fz="xs" c="dimmed" ta="center">
              首次使用？<Anchor fz="xs" component={Link} to="/setup">初始化新实例</Anchor>
            </Text>
          )}
        </Stack>
      </Paper>
    </div>
  );
}
