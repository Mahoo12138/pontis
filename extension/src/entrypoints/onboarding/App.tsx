// First-run guide: connect to a server, pick a space and a folder, done.
//
// This page exists so the settings page does not have to be a wizard. Steps are
// numbered here — where a person arrives once — and nowhere else; every step
// already done collapses to a summary with a way back, because re-running the
// guide after a server move is an edit, not a restart.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Badge, Box, Button, Group, Stack, Text } from '@mantine/core';
import { originPatternFor } from '../../core/pairing/pairing';
import { PontisLogo } from '../../ui/PontisLogo';
import { createRuntime, errText, wakeWorker } from '../../ui/runtime';
import { BindForm, type SpaceOption } from '../../ui/BindForm';
import { PairingForm } from '../../ui/PairingForm';
import { listMountFolders, type FolderOption } from '../../ui/mountFolders';

const runtime = createRuntime();

export function App() {
  const [paired, setPaired] = useState(false);
  const [serverHost, setServerHost] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [bindingCount, setBindingCount] = useState(0);
  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [boundSpaceIds, setBoundSpaceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redoStep, setRedoStep] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const b = await runtime.bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken));
    setDeviceLabel(b.deviceName ?? '');
    if (b.serverUrl) {
      try {
        setServerHost(new URL(b.serverUrl).host);
      } catch {
        setServerHost(b.serverUrl);
      }
    }
    const rows = await runtime.db.bindings.toArray();
    setBindingCount(rows.length);
    setBoundSpaceIds(rows.map((r) => r.spaceId));
    if (b.serverUrl && b.deviceToken) {
      try {
        setSpaces(await runtime.pairing.listSpaces());
      } catch {
        setSpaces([]);
      }
    }
    setFolders(await listMountFolders(runtime.adapter));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
      setRedoStep(null);
      await refresh();
    }
  }

  const doPair = (params: { serverUrl: string; username: string; password: string; deviceName: string }) =>
    void run('pair', async () => {
      const origin = originPatternFor(params.serverUrl);
      const granted = await new Promise<boolean>((resolve) => {
        runtime.chrome.permissions.request({ origins: [origin] }, resolve);
      });
      if (!granted) throw new Error(`需要允许扩展访问 ${origin}`);
      await runtime.pairing.pair({
        serverUrl: params.serverUrl,
        username: params.username,
        password: params.password,
        deviceName: params.deviceName || '浏览器插件',
        browser: 'chromium',
        platform: navigator.platform,
      });
    });

  const doBind = (spaceId: string, folderId: string, spaceName: string) =>
    void run('bind', async () => {
      await runtime.pairing.bindSpace(spaceId, spaceName, folderId);
    });

  const step = !paired ? 1 : bindingCount === 0 ? 2 : 3;

  return (
    <div className="pontis-page">
      <header className="pontis-pageHead">
        <Group gap="xs" wrap="nowrap">
          <PontisLogo size={22} alt="Pontis" />
          <Text className="pontis-pageTitle">Pontis</Text>
          <Text size="md" fw={600}>
            初始设置
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          三步，之后都在设置页里管理
        </Text>
      </header>

      <div className="pontis-pagePad">
        <Stack gap="lg">
          {error && (
            <Alert color="errorRed" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <GuideStep
            index={1}
            title="连接服务器"
            done={paired}
            summary={paired ? `已连接 ${serverHost}，本机以「${deviceLabel || '当前设备'}」身份注册` : undefined}
            redo={redoStep === 1}
            onRedo={() => setRedoStep(1)}
            active={step === 1 || redoStep === 1}
          >
            <PairingForm initialServerUrl={serverHost ? `http://${serverHost}` : ''} busy={busy === 'pair'} onPair={doPair} />
          </GuideStep>

          <GuideStep
            index={2}
            title="选择要同步的空间和书签目录"
            done={bindingCount > 0}
            summary={bindingCount > 0 ? `已绑定 ${bindingCount} 个空间` : undefined}
            redo={redoStep === 2}
            onRedo={() => setRedoStep(2)}
            active={(step === 2 && paired) || redoStep === 2}
            disabled={!paired}
          >
            <BindForm
              spaces={spaces}
              folders={folders}
              boundSpaceIds={boundSpaceIds}
              busy={busy === 'bind'}
              onBind={doBind}
            />
          </GuideStep>

          <GuideStep index={3} title="打开设置页" active={step === 3} done={false}>
            <Stack gap="sm">
              <Text size="sm" c="dimmed">
                绑定会在后台自动同步。设置页里可以看每个空间的书签数、暂停某个空间的同步、重新挂载目录，以及本地日志。
              </Text>
              <Group gap="xs">
                <Button
                  disabled={step !== 3}
                  onClick={() => {
                    void wakeWorker(runtime.chrome);
                    // Same tab: the guide has served its purpose, and leaving a
                    // finished wizard tab behind is one more window to close.
                    // Straight to 同步管理, because that is what was just set up.
                    window.location.href = `${runtime.chrome.runtime.getURL('options.html')}#sync`;
                  }}
                >
                  完成并打开设置页
                </Button>
                {step !== 3 && (
                  <Text size="xs" c="dimmed">
                    完成前两步后可用
                  </Text>
                )}
              </Group>
            </Stack>
          </GuideStep>
        </Stack>
      </div>
    </div>
  );
}

function GuideStep({
  index,
  title,
  active,
  done,
  disabled = false,
  summary,
  redo,
  onRedo,
  children,
}: {
  index: number;
  title: string;
  active: boolean;
  done: boolean;
  disabled?: boolean;
  summary?: string;
  redo?: boolean;
  onRedo?: () => void;
  children: ReactNode;
}) {
  const open = active || !!redo;
  return (
    <section className="pontis-section">
      <Group gap="sm" wrap="nowrap" mb={open ? 'sm' : 4}>
        <Badge
          size="xs"
          variant={done ? 'light' : 'outline'}
          color={done ? 'healthyGreen' : active ? 'accentBlue' : 'coolGray'}
          circle
          aria-hidden
        >
          {index}
        </Badge>
        <Text className="pontis-sectionTitle" component="span" c={disabled && !open ? 'dimmed' : undefined}>
          {title}
        </Text>
        {done && !redo && onRedo && (
          <Button size="compact-xs" variant="subtle" color="coolGray" onClick={onRedo}>
            修改
          </Button>
        )}
      </Group>
      {open ? (
        // Forms read at the width the admin panels use; stretched across the
        // page they look like a settings screen, not a step.
        <Box maw={520}>
          <Stack gap="sm">{children}</Stack>
        </Box>
      ) : summary ? (
        <Text size="xs" c="dimmed" pl={30}>
          {summary}
        </Text>
      ) : null}
    </section>
  );
}
