import type { ReactNode } from 'react';
import { ActionIcon, Group, Text } from '@mantine/core';
import { IconExternalLink, IconMoon, IconSettings, IconSun } from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import { Link } from 'react-router-dom';
import * as styles from '../../styles/start-page.css';

interface Props {
  children: ReactNode;
  /** The weak line under the bookmarks: what the page knows about its own
   * freshness. Never "所有设备已同步" — this view cannot speak for them (§10). */
  status?: ReactNode;
  onConfigure: () => void;
}

/** The start page's own shell: no workspace sidebar, no Explorer header, no
 * Inspector. It is a page the browser opens, not a pane of the workbench (§4.1). */
export default function StartPageLayout({ children, status, onConfigure }: Props) {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <Link to="/start" className={styles.brand}>
            Pontis
          </Link>
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={colorScheme === 'dark' ? '切换到浅色' : '切换到深色'}
              onClick={() => toggleColorScheme()}
            >
              {colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
            </ActionIcon>
            <ActionIcon
              component={Link}
              to="/"
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="打开工作台"
              title="打开工作台"
            >
              <IconExternalLink size={16} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="起始页设置"
              title="起始页设置"
              onClick={onConfigure}
            >
              <IconSettings size={16} />
            </ActionIcon>
          </Group>
        </header>

        {children}

        {status ? (
          <Text className={styles.statusLine} fz="xs" c="dimmed">
            {status}
          </Text>
        ) : null}
      </div>
    </div>
  );
}
