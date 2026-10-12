// Appearance is small, but it is the part of the start page that stores a
// user's own bytes and paints them across the whole window. These tests are the
// boundary: what may become a background at all, what a stored string is
// allowed to look like when it comes back out of IndexedDB, and what has to be
// deleted with the source it belongs to.

import { describe, expect, it } from 'vitest';
import { PontisDB } from '../store/db';
import { clearStartPage, configIdFor } from './provider';
import {
  backgroundLayers,
  defaultAppearance,
  greetingFor,
  isStoredBackground,
  loadAppearance,
  saveAppearance,
  titleFor,
  validateBackgroundInput,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_INPUT_BYTES,
} from './appearance';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function freshDb() {
  const db = new PontisDB(`appearance-test-${Math.random().toString(36).slice(2)}`);
  return db.open().then(() => db);
}

const at = (hour: number) => new Date(2026, 9, 12, hour, 30);

describe('greetingFor', () => {
  it('covers the day in the order a reader expects', () => {
    expect(greetingFor(at(0))).toBe('夜深了');
    expect(greetingFor(at(4))).toBe('夜深了');
    expect(greetingFor(at(5))).toBe('早上好');
    expect(greetingFor(at(10))).toBe('早上好');
    expect(greetingFor(at(11))).toBe('中午好');
    expect(greetingFor(at(13))).toBe('下午好');
    expect(greetingFor(at(17))).toBe('下午好');
    expect(greetingFor(at(18))).toBe('晚上好');
    expect(greetingFor(at(23))).toBe('晚上好');
  });
});

describe('titleFor', () => {
  it('prefers the custom text', () => {
    expect(titleFor({ ...defaultAppearance('x'), titleText: '我的工作台' }, at(9))).toBe('我的工作台');
  });

  it('falls back to the greeting when the text is blank or only spaces', () => {
    expect(titleFor(defaultAppearance('x'), at(14))).toBe('下午好');
    expect(titleFor({ ...defaultAppearance('x'), titleText: '   ' }, at(14))).toBe('下午好');
  });
});

describe('isStoredBackground', () => {
  it('accepts only an inline raster image', () => {
    expect(isStoredBackground(PNG)).toBe(true);
    expect(isStoredBackground('data:image/webp;base64,AAA+=')).toBe(true);
  });

  it('refuses anything that could reach out or execute', () => {
    // A hand-edited row is the threat here: a remote URL in background-image is
    // fetched silently, which is the leak the favicon policy refuses elsewhere.
    expect(isStoredBackground('url(https://evil.example/x.png)')).toBe(false);
    expect(isStoredBackground('https://evil.example/x.png')).toBe(false);
    expect(isStoredBackground('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false);
    expect(isStoredBackground('javascript:alert(1)')).toBe(false);
    expect(isStoredBackground(null)).toBe(false);
    expect(isStoredBackground(undefined)).toBe(false);
  });
});

describe('backgroundLayers', () => {
  it('is absent when there is no image, and when the image is fully transparent', () => {
    expect(backgroundLayers(defaultAppearance('x'))).toBeUndefined();
    expect(backgroundLayers({ ...defaultAppearance('x'), background: PNG, backgroundOpacity: 0 })).toBeUndefined();
  });

  it('veils the image by the theme colour rather than hard-coding one', () => {
    const layers = backgroundLayers({ ...defaultAppearance('x'), background: PNG, backgroundOpacity: 0.35 })!;
    expect(layers.backgroundImage).toContain('color-mix(in srgb, var(--pontis-workspace-bg) 65%, transparent)');
    expect(layers.backgroundImage).toContain(`url("${PNG}")`);
    // Fixed, so a long folder scrolls under the picture instead of carrying it.
    expect(layers.backgroundAttachment).toBe('fixed');
  });

  it('will not put a stored string it does not recognise into the style', () => {
    const layers = backgroundLayers({
      ...defaultAppearance('x'),
      background: 'url(javascript:alert(1))',
      backgroundOpacity: 1,
    });
    expect(layers).toBeUndefined();
  });
});

describe('validateBackgroundInput', () => {
  it('refuses vector and oversized files before decoding either', () => {
    expect(validateBackgroundInput({ type: 'image/svg+xml', size: 100 })).toBe('not-an-image');
    expect(validateBackgroundInput({ type: '', size: 100 })).toBe('not-an-image');
    expect(validateBackgroundInput({ type: 'image/png', size: MAX_BACKGROUND_INPUT_BYTES + 1 })).toBe('source-too-large');
    expect(validateBackgroundInput({ type: 'image/jpeg', size: 1024 })).toBeNull();
  });
});

describe('loadAppearance / saveAppearance', () => {
  it('answers with defaults without writing a row', async () => {
    const db = await freshDb();
    const loaded = await loadAppearance(db, 'i:d');
    expect(loaded).toEqual({ ...defaultAppearance('i:d'), updatedAt: 0 });
    expect(await db.startPageAppearance.count()).toBe(0);
    await db.close();
  });

  it('keeps whatever was set and defaults the opacity', async () => {
    const db = await freshDb();
    expect(DEFAULT_BACKGROUND_OPACITY).toBeGreaterThan(0);
    expect(DEFAULT_BACKGROUND_OPACITY).toBeLessThan(1);

    await saveAppearance(db, 'i:d', { titleText: '开工' });
    await saveAppearance(db, 'i:d', { background: PNG });
    const stored = await loadAppearance(db, 'i:d');
    // A later write must not drop what an earlier one set.
    expect(stored.titleText).toBe('开工');
    expect(stored.background).toBe(PNG);

    expect((await saveAppearance(db, 'i:d', { backgroundOpacity: 5 })).backgroundOpacity).toBe(1);
    expect((await saveAppearance(db, 'i:d', { backgroundOpacity: -3 })).backgroundOpacity).toBe(0);
    expect((await saveAppearance(db, 'i:d', { backgroundOpacity: Number.NaN })).backgroundOpacity).toBe(
      DEFAULT_BACKGROUND_OPACITY,
    );
    await db.close();
  });

  it('goes away with the source it belongs to, and only with that one', async () => {
    const db = await freshDb();
    const mine = configIdFor('i', 'dev-1');
    const other = configIdFor('i', 'dev-2');
    await db.startPageConfigs.bulkPut([
      {
        id: mine,
        instanceId: 'i',
        deviceId: 'dev-1',
        userId: 'u',
        spaceId: 's',
        folderId: 'f',
        searchMode: 'web',
        openTarget: 'current-tab',
        density: 'standard',
        configGeneration: 1,
        updatedAt: 1,
      },
      {
        id: other,
        instanceId: 'i',
        deviceId: 'dev-2',
        userId: 'u',
        spaceId: 's',
        folderId: 'f',
        searchMode: 'web',
        openTarget: 'current-tab',
        density: 'standard',
        configGeneration: 1,
        updatedAt: 1,
      },
    ]);
    await saveAppearance(db, mine, { titleText: '我的', background: PNG });
    await saveAppearance(db, other, { titleText: '别人的' });

    await clearStartPage(db, 'dev-1');

    expect(await db.startPageAppearance.get(mine)).toBeUndefined();
    expect((await db.startPageAppearance.get(other))?.titleText).toBe('别人的');
    await db.close();
  });
});
