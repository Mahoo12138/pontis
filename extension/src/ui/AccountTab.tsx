// The 账号管理 tab: this browser's device identity on the server, and the
// pairing form that establishes or replaces it.
//
// It lived inline in the options page alongside three other tabs. `editPairing`
// is purely this tab's own disclosure, so it moved here rather than staying as
// page state.

import type { ReactNode } from 'react';
import { Anchor, Badge, Box, Button, Group, Stack, Text } from '@mantine/core';
import { Section } from './Section';
import { PairingForm, type PairingParams } from './PairingForm';
import { chromeApi } from '../runtime/chromeApi';
import { metadataForBuild, type UpdateOffer } from '../core/update/release';

export function AccountTab({
  paired,
  serverHost,
  deviceLabel,
  bindingCount,
  pairBusy,
  update,
  installUrl,
  editing,
  onEditingChange,
  onPair,
  onUnpair,
}: {
  paired: boolean;
  serverHost: string;
  deviceLabel: string;
  bindingCount: number;
  pairBusy: boolean;
  update: UpdateOffer | null;
  installUrl: string;
  /** The page opens this once pairing succeeds and again after an unpair. */
  editing: boolean;
  onEditingChange: (next: boolean) => void;
  onPair: (params: PairingParams) => void;
  onUnpair: () => void;
}) {
  const build = metadataForBuild();
  const installedVersion = chromeApi().runtime.getManifest().version;
  const offeredVersion = update?.release || update?.version;
  return (
    <Section
      title="这台浏览器"
      hint="服务器上的设备身份。撤销它会让所有绑定失效，书签本身不受影响。"
      right={
        paired ? (
          <Button size="compact-xs" variant="subtle" color="coolGray" onClick={() => onEditingChange(!editing)}>
            {editing ? '收起' : '修改配对'}
          </Button>
        ) : undefined
      }
    >
      <Box className="pontis-listBox" p="md">
        {paired && !editing ? (
          <Stack gap="sm">
            <MetaRow label="服务器">
              <Text size="sm" className="pontis-mono">
                {serverHost}
              </Text>
            </MetaRow>
            <MetaRow label="设备名称">
              <Text size="sm">{deviceLabel || '当前设备'}</Text>
            </MetaRow>
            <MetaRow label="状态">
              <Group gap="xs" wrap="nowrap">
                <Badge color="healthyGreen" variant="light">
                  已配对
                </Badge>
                <Text size="xs" c="dimmed">
                  {`${bindingCount} 个空间绑定在这台设备上`}
                </Text>
              </Group>
            </MetaRow>
            {/* The version this copy was installed from, and — only when
                this instance really carries a newer package — the way to
                it. Nothing here downloads or runs anything: the link goes
                to the install page, where the upgrade is a person's own
                action (doc §10.3). */}
            <MetaRow label="版本">
              <Stack gap="xs">
                <Text size="sm" className="pontis-mono">
                  {build.release || installedVersion}
                </Text>
                <Text size="xs" c="dimmed" className="pontis-mono">
                  {build.release ? `包版本 ${installedVersion}` : `开发构建${build.dirty ? ' · 有本地修改' : ''}`}
                  {build.commit ? ` · ${build.commit.slice(0, 12)}` : ' · 构建标识未知'}
                </Text>
                {update && installUrl && (
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {update.protocolMismatch
                        ? `本实例提供 ${offeredVersion}，但其同步协议与本版本不匹配`
                        : `本实例提供 ${offeredVersion}`}
                    </Text>
                    <Anchor size="xs" href={installUrl} target="_blank" rel="noreferrer">
                      升级说明
                    </Anchor>
                  </Group>
                )}
              </Stack>
            </MetaRow>
            <Group gap="xs" mt="xs">
              <Button size="xs" variant="subtle" color="errorRed" onClick={onUnpair}>
                解除配对
              </Button>
              <Text size="xs" c="dimmed">
                会撤销本机所有绑定并清空本地副本
              </Text>
            </Group>
          </Stack>
        ) : (
          <Stack gap="sm">
            <PairingForm
              initialServerUrl={serverHost ? `http://${serverHost}` : ''}
              busy={pairBusy}
              submitLabel={paired ? '重新登录并注册' : '登录并注册设备'}
              onPair={onPair}
            />
            {paired && (
              <Text size="xs" c="dimmed">
                重新配对会换掉本设备的凭据，已有的绑定需要重新建立。
              </Text>
            )}
          </Stack>
        )}
      </Box>
    </Section>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap="md" wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={72} flex="0 0 auto">
        {label}
      </Text>
      {children}
    </Group>
  );
}
