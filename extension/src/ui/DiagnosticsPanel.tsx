// The 本地日志 tab: the diagnostics the worker wrote into IndexedDB, newest last.
//
// It lived inline in the options page, which made that file a thousand lines of
// four unrelated tabs. Nothing here is page state — it renders what it is given.

import { Badge, Box, Table, Text, Tooltip } from '@mantine/core';
import { Section } from './Section';
import { levelLabel, scopeLabel } from './diagnosticLabels';
import type { DiagnosticEvent } from '../core/store/db';

export function DiagnosticsPanel({ diagnostics }: { diagnostics: DiagnosticEvent[] }) {
  return (
    <Section
      title="诊断事件（本地）"
      right={
        diagnostics.some((d) => d.level === 'error') ? (
          <Badge color="errorRed" variant="light">
            有错误记录
          </Badge>
        ) : undefined
      }
    >
      {diagnostics.length === 0 ? (
        <Text size="sm" c="dimmed">
          暂无记录。
        </Text>
      ) : (
        <Box mah={280} style={{ overflowY: 'auto' }} className="pontis-stick">
          <Table verticalSpacing="xs" highlightOnHover withTableBorder={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={72}>时间</Table.Th>
                <Table.Th w={72}>级别</Table.Th>
                <Table.Th w={120}>范围</Table.Th>
                <Table.Th>消息</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {diagnostics.map((d, i) => (
                <Table.Tr key={d.id ?? `${d.ts}-${i}`}>
                  <Table.Td>
                    <Text size="xs" className="pontis-numerals" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(d.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="xs"
                      variant="light"
                      color={d.level === 'error' ? 'errorRed' : d.level === 'warn' ? 'warningAmber' : 'coolGray'}
                    >
                      {levelLabel(d.level)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {scopeLabel(d.scope)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={JSON.stringify(d.data ?? {})} maw={420} withArrow>
                      {/* Focusable so the payload is reachable without a mouse
                          (docs/23 §34: keyboard paths and visible focus). */}
                      <Text size="xs" truncate tabIndex={0}>
                        {d.message}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </Section>
  );
}
