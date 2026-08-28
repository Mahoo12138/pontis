import { MantineProvider } from '@mantine/core';
import { pontisTheme } from './pontis-theme';

interface PontisProviderProps {
  children: React.ReactNode;
}

/**
 * Pontis theme provider.
 *
 * Color scheme is managed by Mantine's built-in localStorage-backed
 * manager: `useMantineColorScheme()` toggles it and persists automatically.
 * Scheme-specific colors (Graphite Dark) are handled by the semantic token
 * layer in styles/semantic-tokens.css.ts, keyed on
 * `[data-mantine-color-scheme='dark']`.
 */
export function PontisProvider({ children }: PontisProviderProps) {
  return (
    <MantineProvider theme={pontisTheme} defaultColorScheme="auto">
      {children}
    </MantineProvider>
  );
}
