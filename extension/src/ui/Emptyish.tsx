// The start page's empty-state shape: an icon, a line of what is missing, a
// line of what to do about it, and one action.
//
// It lived inline in the new-tab entrypoint. Exporting it is what lets the
// surface be tested at the component seam, and lets the settings tab reach the
// same shape without copying the wording across.

import type { ReactNode } from 'react';
import { Stack, Title, Text } from '@mantine/core';

export function Emptyish({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <Stack align="center" gap="sm" mt="xl">
      {icon}
      <Title order={6}>{title}</Title>
      <Text size="sm" c="dimmed" ta="center" maw={420}>
        {body}
      </Text>
      {action}
    </Stack>
  );
}
