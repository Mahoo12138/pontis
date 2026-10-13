import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  TextInput,
  PasswordInput,
  Button,
  Group,
  Stack,
  Paper,
  Text,
  Alert,
  Anchor,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useRegister, useSystemStatus } from '../hooks/use-auth';
import { PontisLogo } from '../components/common/PontisLogo';

export default function RegisterPage() {
  const navigate = useNavigate();
  const registerMutation = useRegister();
  const { data: status } = useSystemStatus();
  const [error, setError] = useState<string | null>(null);

  const form = useForm({
    initialValues: {
      username: '',
      password: '',
      confirm_password: '',
      display_name: '',
      email: '',
    },
    validate: {
      username: (v) => (v.length < 3 ? '用户名至少 3 个字符' : null),
      password: (v) => (v.length < 8 ? '密码至少 8 个字符' : null),
      confirm_password: (v, values) => (v === values.password ? null : '两次输入的密码不一致'),
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    try {
      await registerMutation.mutateAsync({
        username: values.username,
        password: values.password,
        display_name: values.display_name,
        email: values.email,
      });
      // Registration creates no session; the login page confirms the account
      // and takes the visitor through.
      navigate('/login', { state: { registered: true } });
    } catch (e: any) {
      setError(e?.message ?? '注册失败');
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
          <Group gap="sm">
            <PontisLogo />
            <Text fz="lg" fw={600}>创建账号</Text>
          </Group>

          {status && !status.allow_registration ? (
            <>
              <Text fz="sm" c="dimmed">这个实例没有开放注册。</Text>
              <Text fz="xs" c="dimmed" ta="center">
                需要账号请联系管理员，或<Anchor fz="xs" component={Link} to="/login">返回登录</Anchor>。
              </Text>
            </>
          ) : (
            <>
              <Text fz="sm" c="dimmed">在这个实例上注册一个普通账号</Text>

              {error && (
                <Alert icon={<IconAlertCircle size={16} />} color="errorRed" variant="light">
                  {error}
                </Alert>
              )}

              <form onSubmit={handleSubmit}>
                <Stack gap="sm">
                  <TextInput
                    label="用户名"
                    placeholder="bob"
                    {...form.getInputProps('username')}
                  />
                  <PasswordInput
                    label="密码"
                    placeholder="至少 8 个字符"
                    autoComplete="new-password"
                    {...form.getInputProps('password')}
                  />
                  <PasswordInput
                    label="确认密码"
                    placeholder="再输入一次"
                    autoComplete="new-password"
                    {...form.getInputProps('confirm_password')}
                  />
                  <TextInput
                    label="显示名称 (可选)"
                    placeholder="Bob"
                    {...form.getInputProps('display_name')}
                  />
                  <TextInput
                    label="邮箱 (可选)"
                    placeholder="bob@example.com"
                    {...form.getInputProps('email')}
                  />
                  <Button type="submit" loading={registerMutation.isPending} fullWidth mt="xs">
                    注册
                  </Button>
                </Stack>
              </form>

              <Text fz="xs" c="dimmed" ta="center">
                已有账号？<Anchor fz="xs" component={Link} to="/login">返回登录</Anchor>
              </Text>
            </>
          )}
        </Stack>
      </Paper>
    </div>
  );
}
