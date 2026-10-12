// Server pairing: the one step that needs a real user gesture.
//
// `chrome.permissions.request` only grants inside a click, and the server sends
// no CORS headers on purpose — so the request has to be the first thing the
// submit handler does, with no await in front of it. That is why this component
// calls `onPair` synchronously and leaves the permission ask to the caller's
// first statement rather than awaiting anything here.

import { useState } from 'react';
import { Button, Group, PasswordInput, Stack, TextInput } from '@mantine/core';

export interface PairingParams {
  serverUrl: string;
  username: string;
  password: string;
  deviceName: string;
}

export function PairingForm({
  initialServerUrl = '',
  busy = false,
  submitLabel = '登录并注册设备',
  onPair,
}: {
  initialServerUrl?: string;
  busy?: boolean;
  submitLabel?: string;
  onPair: (params: PairingParams) => void;
}) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const submit = () => {
    onPair({ serverUrl: serverUrl.trim(), username, password, deviceName: deviceName.trim() });
    // The secret is the only field with no reason to survive the attempt: the
    // address and the device name describe what was just registered.
    setPassword('');
  };

  return (
    <Stack gap="sm">
      <TextInput
        label="服务器地址"
        description="扩展需要被允许访问该地址，浏览器会在点击后询问"
        placeholder="http://localhost:8080"
        value={serverUrl}
        onChange={(e) => setServerUrl(e.currentTarget.value)}
        required
      />
      <Group grow align="flex-start" wrap="wrap">
        <TextInput
          label="用户名"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          autoComplete="username"
          required
        />
        <PasswordInput
          label="密码"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="current-password"
          required
        />
      </Group>
      <TextInput
        label="设备名称"
        description="这台浏览器在服务器上显示的名字，方便日后单独撤销它"
        placeholder="例如：工作电脑 Edge"
        value={deviceName}
        onChange={(e) => setDeviceName(e.currentTarget.value)}
      />
      {/* A Stack stretches its children; a full-width primary button on a form
          this narrow reads like a page-level action. */}
      <Button onClick={submit} loading={busy} style={{ alignSelf: 'flex-start' }}>
        {submitLabel}
      </Button>
    </Stack>
  );
}
