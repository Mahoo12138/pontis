import { useComputedColorScheme } from '@mantine/core';

interface PontisLogoProps {
  size?: number;
  alt?: string;
}

export function PontisLogo({ size = 32, alt = '' }: PontisLogoProps) {
  const colorScheme = useComputedColorScheme('light');

  return (
    <img
      src={colorScheme === 'dark' ? '/brand/pontis-logo-dark.svg' : '/brand/pontis-logo.svg'}
      alt={alt}
      width={size}
      height={size}
      style={{ display: 'block', flexShrink: 0 }}
    />
  );
}
