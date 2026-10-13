import { useComputedColorScheme } from '@mantine/core';
import { chromeApi } from '../runtime/chromeApi';

interface PontisLogoProps {
  size?: number;
  alt?: string;
}

/**
 * Extension pages are served from the extension origin, so a public asset has
 * to be addressed through `runtime.getURL` rather than a root-relative path.
 */
export function PontisLogo({ size = 24, alt = '' }: PontisLogoProps) {
  const colorScheme = useComputedColorScheme('light');
  const file =
    colorScheme === 'dark' ? 'brand/pontis-logo-dark.svg' : 'brand/pontis-logo.svg';

  return (
    <img
      src={chromeApi().runtime.getURL(file)}
      alt={alt}
      width={size}
      height={size}
      style={{ display: 'block', flexShrink: 0 }}
    />
  );
}
