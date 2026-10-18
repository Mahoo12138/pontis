// Settings: three tabs — 账号管理 (this device's pairing), 同步管理 (bindings)
// and 本地日志 (diagnostics written by the worker).
//
// Deliberately not a wizard. The numbered steps live in onboarding.html, which
// a first-time user lands on; by the time someone reaches this page the pairing
// is done, so it reads as an admin panel: state first, actions next to the
// thing they act on, and a repair path only where one exists. The one thing
// this page still has to offer cold is the unpaired account tab, because
// re-pairing after a server move is an edit here, not a trip back to the guide.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  List,
  Modal,
  Stack,
  Switch,
  Tabs,
  Text,
} from '@mantine/core';
import { Section } from '../../ui/Section';
import { runtime } from '../../ui/optionsRuntime';
import { DiagnosticsPanel } from '../../ui/DiagnosticsPanel';
import { AccountTab } from '../../ui/AccountTab';
import { ResyncIntents } from '../../ui/ResyncIntents';
import { SyncTab } from '../../ui/SyncTab';
import { useSyncState } from '../../ui/useSyncState';
import { countScopeBookmarks } from '../../core/browser/scopeCount';
import {
  offerUpdate,
  platformForBuild,
  variantForBuild,
  type UpdateOffer,
} from '../../core/update/release';
import type { ReconciliationIssueWire } from '../../core/protocol/types';

import type { IntentDecision } from '../../core/sync/resync';
import { originPatternFor } from '../../core/pairing/pairing';
import { BindForm } from '../../ui/BindForm';
import { mountFolderTree } from '../../ui/mountFolders';
import { FolderPickerField } from '../../ui/FolderPickerField';
import type { FolderTreeNode } from '../../ui/folderTree';
import { PairingForm } from '../../ui/PairingForm';
import { errText } from '../../ui/runtime';
import { StartPageSettings } from '../../ui/StartPageSettings';
import { bindingStatus } from '../../ui/bindingStatus';
import { scopeLabel } from '../../ui/diagnosticLabels';
import { PontisLogo } from '../../ui/PontisLogo';
import { chromeApi } from '../../runtime/chromeApi';

/**
 * Which of the two packages this copy is.
 *
 * The start page belongs to the takeover build only: the standard build ships no
 * start-page entrypoint at all, so offering its settings here would configure a
 * page that does not exist. The define exists only in a production build.
 */
const newtabBuild = typeof __PONTIS_NEWTAB_BUILD__ !== 'undefined' && __PONTIS_NEWTAB_BUILD__;

type Tab = 'account' | 'sync' | 'start-page' | 'log';

/**
 * Where the page opens. The guide and the popup each mean a particular tab when
 * they send someone here, so making them click out of 账号管理 to get there
 * undoes the link.
 */
function initialTab(): Tab {
  const h = window.location.hash.slice(1);
  if (h === 'sync' || h === 'log') return h;
  if (h === 'start-page' && newtabBuild) return h;
  return 'account';
}

export function App() {
  const { chrome, db, bootstrap, client, adapter, pairing } = runtime;

  const [tab, setTab] = useState<Tab>(initialTab);

  /** Switch tab and put it in the address.
   *
   * The hash is read on load so the guide and the popup can send someone to a
   * particular tab; without writing it back, the URL kept lying about where
   * the reader was, and a reload dropped them on 账号管理. replaceState rather
   * than location.hash so the back button does not walk through tabs the
   * reader already left. */
  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  }, []);
  const [unpairOpen, setUnpairOpen] = useState(false);
  /** Pairing collapses into the header once it is done; the form is for setup. */
  const [editPairing, setEditPairing] = useState(false);
  /** A newer package this instance carries, if it carries one. See below. */
  const [update, setUpdate] = useState<UpdateOffer | null>(null);
  const [installUrl, setInstallUrl] = useState('');
  /** Which action is running: only its own button spins. */
  const sync = useSyncState();
  const {
    busy, error, setError, run, refresh,
    paired, serverHost, deviceLabel,
    spaces, folders, addBinding, setAddBinding,
    bindings, sessions, attention, remountFolders, setRemountFolders, confirmUnbind, setConfirmUnbind,
    diagnostics, intents, intentChoices, setIntentChoice, setIntentChoices, defaultIntentDecision,
    issueChoices, setIssueChoices, counts,
    doBind, doUnbind, toggleSync, answerIssues, resolveIntents, doIntegrityCheck, doRemount,
  } = sync;

  // Ask the instance once whether it carries a newer package — on open, not on
  // the 2s refresh clock, because this is a page view rather than state that
  // moves. Every failure is silence: an offline server, an instance that predates
  // this route, and a body that will not parse all leave the page saying nothing,
  // which is the correct answer for all three. A missing hint costs nothing; a
  // wrong one sends someone to upgrade to a version they already have.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const b = await bootstrap.get();
      if (!b.serverUrl || !b.deviceToken || cancelled) return;
      setInstallUrl(`${b.serverUrl.replace(/\/+$/, '')}/devices#install-extension`);
      try {
        const release = await client.deviceExtensions();
        const offer = offerUpdate(release, {
          platform: platformForBuild(),
          variant: variantForBuild(),
          version: chrome.runtime.getManifest().version,
        });
        if (!cancelled) setUpdate(offer);
      } catch {
        if (!cancelled) setUpdate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doPair = (params: {
    serverUrl: string;
    username: string;
    password: string;
    deviceName: string;
  }) =>
    void run(
      'pair',
      async () => {
        // Granted inside the click gesture, before any other await: the server
        // sends no CORS headers on purpose, so without this origin permission
        // the first pairing fetch is a blocked cross-origin request.
        const origin = originPatternFor(params.serverUrl);
        const granted = await new Promise<boolean>((resolve) => {
          chrome.permissions.request({ origins: [origin] }, resolve);
        });
        if (!granted) throw new Error(`需要允许扩展访问 ${origin}`);
        await pairing.pair({
          serverUrl: params.serverUrl,
          username: params.username,
          password: params.password,
          deviceName: params.deviceName || '浏览器插件',
          browser: 'chromium',
          platform: navigator.platform,
        });
      },
      () => setEditPairing(false),
    );

  const doUnpair = async () => {
    await bootstrap.clearPairing();
    setEditPairing(true);
    await refresh();
  };

  const unbindTarget = bindings.find((b) => b.id === confirmUnbind);
  const unbindPending = unbindTarget
    ? Math.max(0, unbindTarget.receivedRevision - unbindTarget.appliedRevision)
    : 0;

  return (
    <div className="pontis-page">
      <header className="pontis-pageHead">
        <Group gap="xs" wrap="nowrap">
          <PontisLogo size={22} alt="Pontis" />
          <Text className="pontis-pageTitle">Pontis</Text>
          <Text size="md" fw={600}>
            设置
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {paired ? `${serverHost}${deviceLabel ? ` · ${deviceLabel}` : ''}` : '尚未配对'}
        </Text>
      </header>

      <div className="pontis-pagePad">
        {error && (
          <Alert color="errorRed" title="操作失败" withCloseButton onClose={() => setError(null)} mb="md">
            {error}
          </Alert>
        )}
        {!paired && (
          <Alert color="accentBlue" title="这台浏览器还没有配对" mb="md">
            <Stack gap="xs">
              <Text size="sm">
                登录后注册本设备，再选择要同步的空间和书签目录。
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  component="a"
                  href={chrome.runtime.getURL('onboarding.html')}
                  target="_blank"
                >
                  打开初始设置
                </Button>
                <Text size="xs" c="dimmed">
                  或者直接在「账号管理」里登录
                </Text>
              </Group>
            </Stack>
          </Alert>
        )}

        <Tabs value={tab} onChange={(v) => selectTab((v as typeof tab) ?? 'account')}>
          <Tabs.List mb="md">
            <Tabs.Tab value="account">
              账号管理
            </Tabs.Tab>
            <Tabs.Tab
              value="sync"
              rightSection={
                attention.length > 0 ? (
                  <Badge size="xs" color="warningAmber" variant="filled" circle>
                    {attention.length}
                  </Badge>
                ) : undefined
              }
            >
              同步管理
            </Tabs.Tab>
            {newtabBuild && <Tabs.Tab value="start-page">起始页</Tabs.Tab>}
            <Tabs.Tab value="log">本地日志</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="account">
            <AccountTab
              paired={paired}
              serverHost={serverHost}
              deviceLabel={deviceLabel}
              bindingCount={bindings.length}
              pairBusy={busy === 'pair'}
              update={update}
              installUrl={installUrl}
              editing={editPairing}
              onEditingChange={setEditPairing}
              onPair={doPair}
              onUnpair={() => setUnpairOpen(true)}
            />
          </Tabs.Panel>

          <Tabs.Panel value="sync">
            <SyncTab sync={sync} paired={paired} />
          </Tabs.Panel>

          {newtabBuild && (
            <Tabs.Panel value="start-page">
              <Section
                title="起始页来源"
                hint="起始页是这套书签的快速访问视图，不是另一套收藏：它读取工作台中已有的内容，不创建第二棵树，也不改变同步范围。"
              >
                <StartPageSettings onChanged={refresh} />
              </Section>
            </Tabs.Panel>
          )}

          <Tabs.Panel value="log">
            <DiagnosticsPanel diagnostics={diagnostics} />
          </Tabs.Panel>
        </Tabs>
      </div>

      <Modal
        opened={!!unbindTarget}
        onClose={() => setConfirmUnbind(null)}
        title={`解绑「${unbindTarget?.spaceName ?? ''}」`}
      >
        <Stack gap="md">
          <Text size="sm">
            {unbindPending > 0
              ? `${unbindPending} 项还没同步的改动会被丢弃；`
              : ''}
            这台浏览器上的副本会被清空，服务器上的空间和其他设备都不受影响，书签也不会被删。
          </Text>
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={() => setConfirmUnbind(null)}>
              取消
            </Button>
            <Button
              color="errorRed"
              loading={busy === `unbind:${unbindTarget?.id ?? ''}`}
              onClick={() =>
                unbindTarget && void doUnbind(unbindTarget.id).then(() => setConfirmUnbind(null))
              }
            >
              确认解绑
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={unpairOpen} onClose={() => setUnpairOpen(false)} title="解除配对">
        <Stack gap="md">
          <Text size="sm">
            这台设备会向服务器撤销自己的凭据，{bindings.length} 个绑定的本地副本一并清空。
            服务器上的空间和书签不变，重新登录即可再绑。
          </Text>
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={() => setUnpairOpen(false)}>
              取消
            </Button>
            <Button
              color="errorRed"
              onClick={() => {
                setUnpairOpen(false);
                void doUnpair();
              }}
            >
              确认解除
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

/** A labelled line in the account summary. */
