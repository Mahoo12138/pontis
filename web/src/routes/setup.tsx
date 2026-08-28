import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TextInput,
  PasswordInput,
  Button,
  Stack,
  Paper,
  Text,
  Alert,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useSetup } from '../hooks/use-auth';

export default function SetupPage() {
  const navigate = useNavigate();
  const setupMutation = useSetup();
  const [error, setError] = useState<string | null>(null);

  const form = useForm({
    initialValues: { username: '', password: '', display_name: '', email: '' },
    validate: {
      username: (v) => (v.length < 3 ? '用户名至少 3 个字符' : null),
      password: (v) => (v.length < 8 ? '密码至少 8 个字符' : null),
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    try {
      await setupMutation.mutateAsync(values);
      // Backend setup does not issue a session cookie; log in next.
      navigate('/login');
    } catch (e: any) {
      setError(e?.message ?? '创建失败');
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
      <Paper shadow="sm" radius="md" p="xl" w={440}>
        <Stack gap="md">
          <Text fz="lg" fw={600}>初始化 Pontis</Text>
          <Text fz="sm" c="dimmed">创建第一个管理员账户</Text>

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
                placeholder="至少 8 个字符"
                {...form.getInputProps('password')}
              />
              <TextInput
                label="显示名称"
                placeholder="Admin"
                {...form.getInputProps('display_name')}
              />
              <TextInput
                label="邮箱 (可选)"
                placeholder="admin@example.com"
                {...form.getInputProps('email')}
              />
              <Button type="submit" loading={setupMutation.isPending} fullWidth mt="xs">
                创建管理员
              </Button>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </div>
  );
}
