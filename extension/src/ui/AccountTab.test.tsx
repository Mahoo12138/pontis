// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { AccountTab } from './AccountTab';
import type { UpdateOffer } from '../core/update/release';

vi.mock('../runtime/chromeApi', () => ({ chromeApi: () => ({ runtime: { getManifest: () => ({ version: '0.1.0' }) } }) }));
afterEach(() => vi.unstubAllGlobals());
const show = (update: UpdateOffer | null = null) => render(<MantineProvider><AccountTab
  paired serverHost="pontis.test" deviceLabel="Chrome" bindingCount={1} pairBusy={false}
  update={update} installUrl="https://pontis.test/devices#install-extension" editing={false}
  onEditingChange={() => {}} onPair={() => {}} onUnpair={() => {}}
/></MantineProvider>);

it('shows the installed release and commit alongside an explicit protocol warning', () => {
  vi.stubGlobal('__PONTIS_BUILD_METADATA__', { release: 'v0.1.0-alpha.2', commit: 'abcdef1234567890', dirty: false });
  show({ version: '0.1.0', release: 'v0.1.0-alpha.3', protocolMismatch: true });
  expect(screen.getByText('v0.1.0-alpha.2')).toBeTruthy();
  expect(screen.getByText(/abcdef123456/)).toBeTruthy();
  expect(screen.getByText(/v0.1.0-alpha.3.*同步协议与本版本不匹配/)).toBeTruthy();
  expect(screen.getByRole('link', { name: '升级说明' }).getAttribute('href')).toBe('https://pontis.test/devices#install-extension');
});

it('labels dirty local builds without pretending they are the prior alpha release', () => {
  vi.stubGlobal('__PONTIS_BUILD_METADATA__', { release: '', commit: 'abcdef1234567890', dirty: true });
  show();
  expect(screen.getByText(/开发构建.*有本地修改/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: '升级说明' })).toBeNull();
});
