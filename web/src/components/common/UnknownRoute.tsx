import { Button, Stack, Text, Title } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';

/**
 * A path the router does not know. The shell used to render around nothing
 * here, which made a stale or mistyped link look like a broken page; naming the
 * path is what lets a user tell the two apart without opening devtools.
 */
export default function UnknownRoute() {
  const { pathname } = useLocation();
  return (
    <Stack gap="sm" mih="60vh" justify="center" align="flex-start" p="lg">
      <Title order={3}>没有这个页面</Title>
      <Text fz="sm" c="dimmed">
        地址 <Text component="span" span ff="monospace">{pathname}</Text>{' '}
        不属于应用现有的路由。可能是链接过期、地址打错了，或者这个功能还没做。
      </Text>
      <Button component={Link} to="/" variant="light" size="sm">
        回到空间列表
      </Button>
    </Stack>
  );
}
