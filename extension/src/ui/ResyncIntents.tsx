// The pending-intent review a full resync pauses for (doc 06 §11).
//
// It is its own module because it is a self-contained decision list — the page
// only supplies the ops and the callbacks — and because the sync tab it lived in
// was the last part of the options page with no test of any kind.

import { Badge, Button, Group, List, Stack, Text } from '@mantine/core';
import type { PendingOpRecord } from '../core/store/db';
import type { IntentDecision } from '../core/sync/resync';

export function ResyncIntents({
  intents,
  chosen,
  onChoose,
  onAll,
  onSubmit,
  busy,
}: {
  intents: PendingOpRecord[];
  chosen: (op: PendingOpRecord) => IntentDecision['decision'];
  onChoose: (opId: string, decision: IntentDecision['decision']) => void;
  onAll: (decision: 'default' | 'discard') => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        以下未同步的操作跨过了服务端重置,请逐条决定是否保留(旧操作将按当前服务器状态重新生成):
      </Text>
      {intents.length === 0 ? (
        <Text size="xs" c="dimmed">
          无待审操作,可直接重新同步。
        </Text>
      ) : (
        <List withPadding size="sm" spacing="xs">
          {intents.map((op) => (
            <List.Item key={op.opId}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Badge size="xs" variant="light" color={op.type === 'delete' ? 'errorRed' : 'accentBlue'}>
                    {op.type}
                  </Badge>
                  <Text size="sm" truncate maw={320}>
                    {op.title || '(无标题)'}
                    {op.url ? ` · ${op.url}` : ''}
                  </Text>
                </Group>
                <Button.Group>
                  <Button
                    size="compact-xs"
                    variant={chosen(op) === 'apply' ? 'filled' : 'light'}
                    onClick={() => onChoose(op.opId, 'apply')}
                  >
                    保留
                  </Button>
                  <Button
                    size="compact-xs"
                    color="coolGray"
                    variant={chosen(op) === 'discard' ? 'filled' : 'light'}
                    onClick={() => onChoose(op.opId, 'discard')}
                  >
                    放弃
                  </Button>
                </Button.Group>
              </Group>
            </List.Item>
          ))}
        </List>
      )}
      <Group gap="xs" wrap="nowrap">
        <Button size="xs" variant="light" disabled={intents.length === 0} onClick={() => onAll('default')}>
          全部按建议
        </Button>
        <Button size="xs" variant="subtle" color="coolGray" disabled={intents.length === 0} onClick={() => onAll('discard')}>
          全部放弃
        </Button>
        <Button color="accentBlue" loading={busy} onClick={onSubmit}>
          提交决策
        </Button>
      </Group>
    </Stack>
  );
}
