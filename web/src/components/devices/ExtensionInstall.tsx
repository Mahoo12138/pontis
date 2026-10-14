import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  CopyButton,
  Group,
  Skeleton,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBrandChrome,
  IconBrandFirefox,
  IconCheck,
  IconCopy,
  IconDownload,
} from '@tabler/icons-react';
import type { DistributionArtifact } from '@pontis/api';
import ErrorState from '../common/ErrorState';
import { mono, sectionHint, sectionTitle } from '../../styles/management.css';
import { tokens } from '../../styles/semantic-tokens.css';
import { useExtensionDistribution } from '../../hooks/use-distribution';
import { formatSize } from '../../lib/format';

/**
 * The install surface of the 设备 page (distribution doc §8).
 *
 * It is on the ordinary device page rather than under 管理 → 系统设置 because a
 * person who has not installed the extension yet is exactly the user who must
 * not need an admin role to get it. Everything on screen describes *this*
 * instance's own release: the package, its digest and its version come from the
 * binary that is answering, not from a browser store.
 */

const BROWSER_LABEL: Record<string, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
};

export default function ExtensionInstall() {
  const { data, isLoading, isError, error, refetch } = useExtensionDistribution();

  if (isError) {
    return (
      <ErrorState error={error} onRetry={() => void refetch()} />
    );
  }
  if (isLoading) {
    return <Skeleton height={160} />;
  }

  const artifacts = data?.artifacts ?? [];
  const chromium = artifacts.find((a) => a.platform === 'chromium') ?? null;
  const firefox = artifacts.find((a) => a.platform === 'firefox') ?? null;

  return (
    <section id="install-extension">
      <Text className={sectionTitle} mb={4}>安装 Pontis 浏览器扩展</Text>
      <Text className={sectionHint} mb="md">
        安装包由当前实例提供,不是浏览器商店的版本。Chrome 与 Edge 通过开发者模式手动加载,
        升级时保持同一目录即可沿用现有设备身份与本地数据。
      </Text>

      {chromium ? (
        <ChromiumRelease artifact={chromium} builtAt={data?.generated_at ?? ''} commit={data?.commit ?? ''} />
      ) : (
        <NothingStaged />
      )}

      {chromium && <FirstInstallSteps />}

      {chromium && <UpgradeSteps />}

      <FirefoxRelease artifact={firefox} />
    </section>
  );
}

// ─── What this instance carries ──────────────────────────────

function ChromiumRelease({
  artifact,
  builtAt,
  commit,
}: {
  artifact: DistributionArtifact;
  builtAt: string;
  commit: string;
}) {
  // The list is what the build tested, not what the format supports: the same
  // Chromium package loads in Edge, and doc §16.2 makes shared support a test
  // result. So Edge is named as untested rather than hidden or claimed.
  const tested = artifact.supported_browsers.map((b) => BROWSER_LABEL[b] ?? b);
  const edgeTested = artifact.supported_browsers.includes('edge');

  return (
    <div style={{ borderTop: `1px solid ${tokens.subtleBorder}`, paddingTop: 12, paddingBottom: 4 }}>
      <Group gap={10} wrap="nowrap" align="flex-start">
        <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <IconBrandChrome size={16} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <Group gap={8} wrap="nowrap">
              <Text fz={13} fw={500}>Chrome / Edge</Text>
              <Text className={mono} fz={12} style={{ color: tokens.textSecondary }}>
                v{artifact.version}
              </Text>
              <Text fz={12} c="dimmed">{formatSize(artifact.size_bytes)}</Text>
              <Text fz={12} c="dimmed">Manifest V3</Text>
            </Group>
            <Text fz={12} c="dimmed" mt={2}>
              已实测 {tested.join('、')}
              {edgeTested ? '' : '。Edge 使用同一个安装包,尚未实机验证'}
            </Text>
          </div>
        </Group>
        <Button
          size="compact-sm"
          component="a"
          href={artifact.file}
          leftSection={<IconDownload size={14} stroke={1.7} />}
        >
          下载 ZIP
        </Button>
      </Group>

      <DigestRow artifact={artifact} />

      <Text fz={12} c="dimmed" mt={6}>
        {buildLine(builtAt, commit, artifact.min_server_version)}
      </Text>
    </div>
  );
}

/**
 * The checksum is shown in full and copyable. It is not proof that the package
 * came from this instance — that is what a trusted download channel is for
 * (doc §13) — but a person who compares it after downloading can at least catch
 * a truncated or altered file.
 */
function DigestRow({ artifact }: { artifact: DistributionArtifact }) {
  const short = `${artifact.sha256.slice(0, 16)}…${artifact.sha256.slice(-8)}`;
  return (
    <Group gap={8} wrap="nowrap" mt={8}>
      <Text fz={12} c="dimmed" style={{ flexShrink: 0 }}>SHA-256</Text>
      <Text className={mono} fz={12} truncate="end" style={{ color: tokens.textSecondary }}>
        {short}
      </Text>
      <CopyButton value={artifact.sha256}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? '已复制完整摘要' : '复制完整摘要'} withArrow>
            <UnstyledButton
              onClick={copy}
              aria-label="复制 SHA-256"
              style={{ color: copied ? tokens.syncHealthy : tokens.textSecondary, display: 'inline-flex', flexShrink: 0 }}
            >
              {copied ? <IconCheck size={14} stroke={1.7} /> : <IconCopy size={14} stroke={1.5} />}
            </UnstyledButton>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

function buildLine(builtAt: string, commit: string, minServer: string) {
  const when = builtAt ? new Date(builtAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  const sha = commit ? commit.slice(0, 7) : '未知';
  return `构建于 ${when} · 来自提交 ${sha} · 要求 Server 不低于 ${minServer}`;
}

function NothingStaged() {
  // A server binary built without the extension package is a real state, not a
  // rendering bug: doc §5 stages the ZIP into the Go embed at build time, so an
  // image built from a bare `go build` carries nothing to hand out. Saying so is
  // more useful than an empty list.
  return (
    <div style={{ borderTop: `1px solid ${tokens.subtleBorder}`, paddingTop: 12 }}>
      <Group gap={8} wrap="nowrap">
        <IconBrandChrome size={16} stroke={1.5} style={{ color: tokens.textDisabled, flexShrink: 0 }} />
        <Text fz={13} c="dimmed">
          这个实例的二进制里没有内嵌扩展安装包,因此无法从这里下载。
        </Text>
      </Group>
      <Text fz={12} c="dimmed" mt={6} pl={24}>
        服务端需要从仓库根执行一次完整的发布构建(`pnpm build`:编译 Web 与扩展、暂存产物、再
        `go build`),重新部署后即可在此下载。已连接设备的同步不受影响。
      </Text>
    </div>
  );
}

// ─── Steps ───────────────────────────────────────────────────

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <Text fz={12} fw={600} style={{ color: tokens.textSecondary, marginTop: 16 }}>
      {children}
    </Text>
  );
}

/**
 * Numbered rows rather than a list marker: the numbers are read as positions in
 * a procedure, and the column keeps its width when a step wraps to a second
 * line.
 */
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <Stack gap={6} mt="xs">
      {items.map((item, index) => (
        <Group key={index} gap={10} wrap="nowrap" align="flex-start">
          <Text
            className={mono}
            fz={12}
            c="dimmed"
            style={{ width: 14, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
          >
            {index + 1}
          </Text>
          <Text fz={13} style={{ maxWidth: '64ch' }}>
            {item}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function Path({ children }: { children: ReactNode }) {
  return (
    <Text component="span" className={mono} fz={12} style={{ color: tokens.textPrimary }}>
      {children}
    </Text>
  );
}

function FirstInstallSteps() {
  return (
    <div style={{ borderTop: `1px solid ${tokens.subtleBorder}`, marginTop: 16, paddingTop: 4 }}>
      <SubHeading>首次安装</SubHeading>
      <Steps
        items={[
          <>点击上方「下载 ZIP」。</>,
          <>
            解压到一个<strong style={{ fontWeight: 500 }}>以后不再移动的目录</strong>,例如{' '}
            <Path>%LOCALAPPDATA%/Pontis/Extension</Path> (Windows)或{' '}
            <Path>~/Applications/Pontis/Extension</Path> (macOS)。
          </>,
          <>
            地址栏打开 <Path>chrome://extensions</Path>,Edge 为 <Path>edge://extensions</Path>。
          </>,
          <>打开右上角的「开发者模式」开关。</>,
          <>
            点「加载已解压的扩展程序」,选择<strong style={{ fontWeight: 500 }}>直接包含
            <Path>manifest.json</Path> 的那一层目录</strong>——不是 ZIP 文件,也不是外面多套一层的目录。
          </>,
          <>
            确认扩展出现在列表里,打开它,填写本实例地址,用「添加设备」得到的密钥完成配对与首次同步。
          </>,
          <>
            开发者模式安装会伴随浏览器的安全提示,这是手动安装路径本身带来的,如实保留即可;
            不需要为此关闭任何安全功能。
          </>,
        ]}
      />
    </div>
  );
}

function UpgradeSteps() {
  return (
    <div style={{ borderTop: `1px solid ${tokens.subtleBorder}`, marginTop: 16, paddingTop: 4 }}>
      <SubHeading>手动升级</SubHeading>
      <Text fz={12} c="dimmed" mt={4} style={{ maxWidth: '64ch' }}>
        升级不需要卸载,也不应该卸载:扩展 ID、设备身份、绑定关系与本地待上传的改动都留在原来的
        Profile 里。导出书签不是等价备份,它保存不了尚未上传的操作。
      </Text>
      <Steps
        items={[
          <>先在扩展里确认没有排队中的改动或未完成的恢复,尽量把同步跑完。</>,
          <>下载新的 ZIP,并核对页面显示的 SHA-256。</>,
          <>
            把当前目录完整复制一份作为备份,<strong style={{ fontWeight: 500 }}>保留旧扩展,不要卸载</strong>。
          </>,
          <>
            在临时目录解压新包,确认 <Path>manifest.json</Path> 里的版本与本页一致,再替换稳定目录中的文件,
            不要留下旧版本的 JS 分片。
          </>,
          <>
            回到 <Path>chrome://extensions</Path> 点击该扩展的「重新加载」。
          </>,
          <>
            打开扩展,确认扩展 ID、设备名称、绑定空间数量与未完成操作数量和升级前一致。
          </>,
          <>
            如果升级后要求恢复(<Path>RECOVERY_REQUIRED</Path>),走 Pontis 的恢复流程;
            清空本地数据、删除绑定或卸载重装都不是恢复手段。回退扩展代码不等于能回退已升级的本地数据结构。
          </>,
        ]}
      />
    </div>
  );
}

// ─── Firefox ─────────────────────────────────────────────────

function FirefoxRelease({ artifact }: { artifact: DistributionArtifact | null }) {
  // An unsigned ZIP renamed to `.xpi` is not a Firefox package: Firefox Desktop
  // needs an AMO-signed XPI to keep an extension installed (doc §11), so until a
  // signed one is part of the release this says 暂未开放 and offers no file.
  return (
    <div style={{ borderTop: `1px solid ${tokens.subtleBorder}`, marginTop: 20, paddingTop: 12 }}>
      <Group gap={8} wrap="nowrap" align="flex-start">
        <IconBrandFirefox size={16} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap={8} wrap="nowrap">
            <Text fz={13} fw={500}>Firefox</Text>
            {artifact ? (
              <Text className={mono} fz={12} style={{ color: tokens.textSecondary }}>
                v{artifact.version}
              </Text>
            ) : (
              <Badge variant="light" color="coolGray" styles={{ root: { fontWeight: 400 } }}>
                暂未开放
              </Badge>
            )}
          </Group>
          {artifact ? (
            <>
              <Text fz={12} c="dimmed" mt={2}>
                已签名的 XPI,可从 Firefox 的附加组件管理界面「从文件安装」。
              </Text>
              <Group gap={8} wrap="nowrap" mt={8}>
                <DigestRow artifact={artifact} />
              </Group>
            </>
          ) : (
            <Text fz={12} c="dimmed" mt={2} style={{ maxWidth: '64ch' }}>
              Firefox 正式版要求扩展经过 Mozilla 签名,未签名的包无法长期保留。
              本发布批次只交付 Chromium 安装包;签名产物就绪后会作为独立的 XPI 出现在这里,
              在此之前不要把 ZIP 改后缀当作 XPI 安装。
            </Text>
          )}
        </div>
        {artifact && (
          <Button
            size="compact-sm"
            component="a"
            href={artifact.file}
            leftSection={<IconDownload size={14} stroke={1.7} />}
          >
            下载 XPI
          </Button>
        )}
      </Group>
    </div>
  );
}
