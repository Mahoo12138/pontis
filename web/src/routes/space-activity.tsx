import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Skeleton, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconArrowForwardUp,
  IconHistory,
} from '@tabler/icons-react';
import type { ActivityAction, ActivityEntry } from '@pontis/api';
import Header from '../components/app-shell/Header';
import { contentRegion } from '../styles/app-shell.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useActivity } from '../hooks/use-activity';
import { useSpaces } from '../hooks/use-spaces';
import { formatDayLabel, formatShortTime } from '../lib/format';

const ACTION_META: Record<ActivityAction, { icon: typeof IconPlus; color: string; label: string }> = {
  create: { icon: IconPlus, color: 'var(--mantine-color-healthyGreen-6)', label: '新建' },
  update: { icon: IconPencil, color: 'var(--mantine-color-accentBlue-6)', label: '修改' },
  move: { icon: IconArrowForwardUp, color: 'var(--mantine-color-accentBlue-6)', label: '移动' },
  delete: { icon: IconTrash, color: 'var(--mantine-color-errorRed-6)', label: '删除' },
};

export default function SpaceActivityPage() {
  const { spaceId } = useParams();
  const { data, isLoading } = useActivity(spaceId);
  const { data: spacesData } = useSpaces();
  const spaceName = spacesData?.spaces?.find((s) => s.id === spaceId)?.name ?? '空间';

  // Local undo state: the backend will own real undo later.
  const [undone, setUndone] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const entries = data?.activity ?? [];
    const byDay = new Map<string, ActivityEntry[]>();
    for (const entry of entries) {
      const day = formatDayLabel(entry.timestamp);
      const list = byDay.get(day) ?? [];
      list.push(entry);
      byDay.set(day, list);
    }
    return [...byDay.entries()];
  }, [data]);

  const handleUndo = (entry: ActivityEntry) => {
    setUndone((prev) => new Set(prev).add(entry.id));
    notifications.show({
      title: '已撤销',
      message: entry.summary,
      color: 'healthyGreen',
    });
  };

  return (
    <>
      <Header breadcrumb={`${spaceName} / 最近活动`} />
      <div className={contentRegion} style={{ overflowY: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>
          {isLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} height={44} />
              ))}
            </div>
          )}

          {!isLoading && groups.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                paddingTop: 80,
                color: tokens.textSecondary,
              }}
            >
              <IconHistory size={32} stroke={1.2} />
              <Text fz="sm">还没有活动记录</Text>
              <Text fz="xs" c="dimmed">设备同步或手动修改后，活动会出现在这里。</Text>
            </div>
          )}

          {groups.map(([day, entries]) => (
            <section key={day} style={{ marginBottom: 24 }}>
              <Text fz="xs" fw={500} c="dimmed" style={{ marginBottom: 8 }}>
                {day}
              </Text>
              <div style={{ position: 'relative', paddingLeft: 24 }}>
                {/* day rail */}
                <div
                  style={{
                    position: 'absolute',
                    left: 7,
                    top: 6,
                    bottom: 6,
                    width: 1,
                    backgroundColor: tokens.subtleBorder,
                  }}
                />
                {entries.map((entry) => {
                  const meta = ACTION_META[entry.action] ?? ACTION_META.create;
                  const Icon = meta.icon;
                  const isUndone = undone.has(entry.id);
                  return (
                    <div
                      key={entry.id}
                      style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '8px 0',
                      }}
                    >
                      {/* dot */}
                      <span
                        style={{
                          position: 'absolute',
                          left: -21,
                          width: 15,
                          height: 15,
                          borderRadius: '50%',
                          backgroundColor: tokens.workspaceBg,
                          border: `2px solid ${meta.color}`,
                          boxSizing: 'border-box',
                        }}
                      />
                      <Icon size={15} stroke={1.5} style={{ color: meta.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text fz="sm" style={{ opacity: isUndone ? 0.5 : 1, textDecoration: isUndone ? 'line-through' : 'none' }}>
                          {entry.summary}
                        </Text>
                        <Text fz="xs" c="dimmed">
                          {formatShortTime(entry.timestamp)} · {entry.actor} · {meta.label}
                        </Text>
                      </div>
                      {entry.undoable && !isUndone && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="coolGray"
                          onClick={() => handleUndo(entry)}
                        >
                          撤销
                        </Button>
                      )}
                      {isUndone && (
                        <Text fz="xs" c="dimmed">已撤销</Text>
                      )}
                      {!entry.undoable && (
                        <Text fz="xs" c="dimmed">撤销已过期</Text>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
