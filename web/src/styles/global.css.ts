import { globalStyle } from '@vanilla-extract/css';

/** Global base styles — body reset, font stack, scroll behavior. */

globalStyle('html', {
  height: '100%',
  WebkitFontSmoothing: 'antialiased',
  MozOsxFontSmoothing: 'grayscale',
  textRendering: 'optimizeLegibility',
});

globalStyle('body', {
  height: '100%',
  margin: 0,
  padding: 0,
  overflow: 'hidden',
});

globalStyle('#root', {
  height: '100%',
});

globalStyle('*, *::before, *::after', {
  boxSizing: 'border-box',
});

globalStyle(':focus-visible', {
  outline: '2px solid var(--mantine-color-accentBlue-5)',
  outlineOffset: '2px',
});

globalStyle(':focus:not(:focus-visible)', {
  outline: 'none',
});
