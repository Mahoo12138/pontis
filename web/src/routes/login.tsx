import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TextInput, PasswordInput, Button, Stack, Paper, Text, Alert, Anchor } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useLogin } from '../hooks/use-auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const loginMutation = useLogin();
  const [error, setError] = useState<string | null>(null);

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
          <Text fz="lg" fw={600}>Pontis</Text>
          <Text fz="sm" c="dimmed">登录到你的书签工作空间</Text>

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

          <Text fz="xs" c="dimmed" ta="center">
            首次使用？<Anchor fz="xs" component={Link} to="/setup">初始化新实例</Anchor>
          </Text>
        </Stack>
      </Paper>
    </div>
  );
}
