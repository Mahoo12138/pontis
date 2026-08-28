import { useState } from 'react';
import {
  MantineProvider,
  ColorSchemeProvider,
  type ColorScheme,
  createTheme,
  mergeMantineTheme,
} from '@mantine/core';
import { pontisTheme } from './pontis-theme';
import { darkColorOverrides } from './pontis-dark';

/** Merged theme with dark mode color overrides baked in. */
const theme = mergeMantineTheme(
  pontisTheme,
  createTheme({
    colors: darkColorOverrides,
  }),
);

interface PontisProviderProps {
  children: React.ReactNode;
}

export function PontisProvider({ children }: PontisProviderProps) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(
    () =>
      (localStorage.getItem('pontis-color-scheme') as ColorScheme) ?? 'light',
  );

  const toggleColorScheme = (value?: ColorScheme) => {
    const next = value ?? (colorScheme === 'dark' ? 'light' : 'dark');
    setColorScheme(next);
    localStorage.setItem('pontis-color-scheme', next);
  };

  return (
    <ColorSchemeProvider
      colorScheme={colorScheme}
      toggleColorScheme={toggleColorScheme}
    >
      <MantineProvider
        theme={theme}
        defaultColorScheme="light"
        forceColorScheme={colorScheme}
      >
        {children}
      </MantineProvider>
    </ColorSchemeProvider>
  );
}
