import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Center, Loader, Text } from '@mantine/core';
import { useSpaces } from '../hooks/use-spaces';
import { tokens } from '../styles/semantic-tokens.css';

/**
 * Landing route: redirect to the user's first space. Space ids are server
 * generated UUIDs, so the redirect target must come from the spaces query.
 */
export default function SpacesIndexPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useSpaces();

  const first = data?.spaces?.[0];

  useEffect(() => {
    if (first) {
      navigate(`/spaces/${first.id}`, { replace: true });
    }
  }, [first, navigate]);

  if (isLoading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  return (
    <Center h="100%">
      <Text size="sm" c={tokens.textSecondary}>
        {isError ? '无法加载空间列表' : '还没有任何空间，先创建一个吧'}
      </Text>
    </Center>
  );
}
