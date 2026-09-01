// Options: pairing (server → login → device registration), binding
// (partial mount folder selection) and a local diagnostics view.

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  PasswordInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { createChromiumAdapter } from '../../core/browser/chromium';
import { ApiClient } from '../../core/transport/client';
import { BootstrapStore } from '../../core/store/bootstrap';
import { PontisDB, type BindingRecord, type DiagnosticEvent } from '../../core/store/db';
import { PairingService } from '../../core/pairing/pairing';
import { chromeApi } from '../../runtime/chromeApi';

interface FolderOption {
  value: string;
  label: string;
}

export function App() {
  const chrome = chromeApi();
  const db = new PontisDB();
  const bootstrap = new BootstrapStore(chrome.storage.local);
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  const adapter = createChromiumAdapter(chrome.bookmarks);
  const pairing = new PairingService(client, bootstrap, db);

  const [paired, setPaired] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  const [bindings, setBindings] = useState<BindingRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);

  const refresh = useCallback(async () => {
    setBindings(await db.bindings.toArray());
    setDiagnostics((await db.diagnostics.orderBy('id').reverse().limit(30).toArray()).reverse());
    const b = await bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken));
    if (b.serverUrl) setServerUrl(b.serverUrl);
    if (b.deviceToken) {
      try {
        setSpaces(await pairing.listSpaces());
      } catch {
        setSpaces([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    void loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFolders() {
    // Flatten the browser folder tree for mount selection.
    const options: FolderOption[] = [];
    const walk = async (parentId: string, depth: number, prefix: string) => {
      const children = await adapter.getChildren(parentId);
      for (const c of children.filter((n) => n.type === 'folder')) {
        const label = `${prefix}${c.title || '(未命名)'}`;
        options.push({ value: c.id, label: `${' '.repeat(depth * 2)}${label}` });
        await walk(c.id, depth + 1, `${label} / `);
      }
    };
    await walk('0', 0, '');
    setFolders(options);
  }

  const doPair = async () => {
    setBusy(true);
    setError(null);
    try {
      await pairing.pair({
        serverUrl: serverUrl.trim(),
        username,
        password,
        deviceName: deviceName.trim() || '浏览器插件',
        browser: 'chromium',
        platform: navigator.platform,
      });
      setPaired(true);
      setPassword('');
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doBind = async () => {
    if (!selectedSpace || !selectedFolder) return;
    setBusy(true);
    setError(null);
    try {
      const space = spaces.find((s) => s.id === selectedSpace);
      await pairing.bindSpace(selectedSpace, space?.name ?? selectedSpace, selectedFolder);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const doUnbind = async (bindingId: string) => {
    await pairing.unbind(bindingId);
    await refresh();
  };

  const doUnpair = async () => {
    await bootstrap.clearPairing();
    await refresh();
  };

  return (
    <Container size={720} py="xl">
      <Stack gap="lg">
        <Title order={2}>Pontis 设置</Title>

        {error && (
          <Alert color="red" title="操作失败">
            {error}
          </Alert>
        )}

        <Stack gap="sm">
          <Title order={4}>1. 配对服务器</Title>
          <TextInput
            label="服务器地址"
            placeholder="http://localhost:8080"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.currentTarget.value)}
          />
          <Group grow>
            <TextInput label="用户名" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
            <PasswordInput label="密码" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
          </Group>
          <TextInput
            label="设备名称"
            placeholder="例如:工作电脑 Edge"
            value={deviceName}
            onChange={(e) => setDeviceName(e.currentTarget.value)}
          />
          <Group>
            <Button loading={busy} onClick={() => void doPair()}>
              登录并注册设备
            </Button>
            {paired && (
              <Button variant="subtle" color="gray" onClick={() => void doUnpair()}>
                解除配对
              </Button>
            )}
            {paired && <Badge color="green">已配对</Badge>}
          </Group>
        </Stack>

        <Stack gap="sm">
          <Title order={4}>2. 绑定同步空间(Partial Sync)</Title>
          <Text size="sm" c="dimmed">
            选择一个空间,再选择浏览器中作为挂载点的书签目录。挂载目录内的书签将与该空间保持同步;目录本身不会上传。
          </Text>
          <Group grow>
            <Select
              label="同步空间"
              placeholder="选择空间"
              data={spaces.map((s) => ({ value: s.id, label: s.name }))}
              value={selectedSpace}
              onChange={setSelectedSpace}
            />
            <Select
              label="挂载目录"
              placeholder="选择书签目录"
              data={folders}
              value={selectedFolder}
              onChange={setSelectedFolder}
              searchable
            />
          </Group>
          <Button loading={busy} disabled={!paired || !selectedSpace || !selectedFolder} onClick={() => void doBind()}>
            创建绑定
          </Button>
        </Stack>

        <Stack gap="sm">
          <Title order={4}>绑定列表</Title>
          {bindings.length === 0 ? (
            <Text size="sm" c="dimmed">
              暂无绑定。
            </Text>
          ) : (
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>空间</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>applied / received</Table.Th>
                  <Table.Th>最近同步</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {bindings.map((b) => (
                  <Table.Tr key={b.id}>
                    <Table.Td>{b.spaceName}</Table.Td>
                    <Table.Td>
                      <Badge color={b.state === 'active' ? 'green' : b.state === 'needs_recovery' ? 'red' : 'orange'}>
                        {b.state}
                      </Badge>
                      {b.recovery ? <Text size="xs" c="red">{b.recovery.code}</Text> : null}
                    </Table.Td>
                    <Table.Td>
                      {b.appliedRevision} / {b.receivedRevision}
                    </Table.Td>
                    <Table.Td>{b.lastSyncAt ? new Date(b.lastSyncAt).toLocaleString() : '—'}</Table.Td>
                    <Table.Td>
                      <Button size="compact-xs" variant="subtle" color="red" onClick={() => void doUnbind(b.id)}>
                        解绑
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>

        <Stack gap="sm">
          <Title order={4}>诊断事件(本地)</Title>
          {diagnostics.length === 0 ? (
            <Text size="sm" c="dimmed">
              暂无记录。
            </Text>
          ) : (
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>时间</Table.Th>
                  <Table.Th>级别</Table.Th>
                  <Table.Th>范围</Table.Th>
                  <Table.Th>消息</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {diagnostics.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td>{new Date(d.ts).toLocaleTimeString()}</Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        color={d.level === 'error' ? 'red' : d.level === 'warn' ? 'orange' : 'gray'}
                        variant="light"
                      >
                        {d.level}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{d.scope}</Table.Td>
                    <Table.Td>{d.message}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Stack>
    </Container>
  );
}

function errText(err: unknown): string {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message;
  return code ? `${code}: ${message ?? ''}` : String(err);
}
