// Appearance is small, but it is the part of the start page that stores a
// user's own bytes and paints them across the whole window. These tests are the
// boundary: what may become a background at all, what a stored string is
// allowed to look like when it comes back out of IndexedDB, and what has to be
// deleted with the source it belongs to.

import { describe, expect, it } from 'vitest';
import { PontisDB, type StartPageAppearanceRecord } from '../store/db';
import { clearStartPage, configIdFor } from './provider';
import {
  backgroundLayers,
  defaultAppearance,
  greetingFor,
  isStoredBackground,
  loadAppearance,
  saveAppearance,
  surfaceLayers,
  titleFor,
  validateBackgroundInput,
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_SURFACE_OPACITY,
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
  const look = (patch: Partial<StartPageAppearanceRecord> = {}) => ({
    ...defaultAppearance('x'),
    background: PNG,
    backgroundOpacity: 0.35,
    ...patch,
  });

  it('is absent only when there is no picture at all', () => {
    expect(backgroundLayers(defaultAppearance('x'), 'light')).toBeUndefined();
    expect(backgroundLayers({ ...defaultAppearance('x'), backgroundOpacity: 0.35 }, 'light')).toBeUndefined();
  });

  it('veils the image by the page colour rather than hard-coding one', () => {
    const layers = backgroundLayers(look(), 'light')!;
    expect(layers.backgroundImage).toContain('color-mix(in srgb, var(--pontis-workspace-bg) 65%, transparent)');
    expect(layers.backgroundImage).toContain(`url("${PNG}")`);
    // Fixed, so a long folder scrolls under the picture instead of carrying it.
    expect(layers.backgroundAttachment).toBe('fixed');
  });

  it('lays the colour read from the picture under both schemes', () => {
    // The pair is one decision made twice, so the page picks which half to use
    // from the scheme it is already rendering in.
    const painted = { tintLight: '#f4f7fb', tintDark: '#161a20' };
    expect(backgroundLayers(look(painted), 'light')!['--pontis-workspace-bg']).toBe('#f4f7fb');
    expect(backgroundLayers(look(painted), 'dark')!['--pontis-workspace-bg']).toBe('#161a20');
    // And the veil is mixed from that same colour, not from a second literal.
    expect(backgroundLayers(look(painted), 'dark')!.backgroundImage).toContain('var(--pontis-workspace-bg)');
  });

  it('keeps the colour when the picture is faded out entirely', () => {
    // Opacity 0 means the photograph is gone, not that the page stops being the
    // colour that was read out of it, or that its surfaces go transparent.
    expect(backgroundLayers(look({ tintLight: '#f4f7fb', backgroundOpacity: 0 }), 'light')).toEqual({
      ...surfaceLayers(DEFAULT_SURFACE_OPACITY),
      '--pontis-workspace-bg': '#f4f7fb',
    });
  });

  it('will not take a colour or an image it does not recognise', () => {
    // A hand-edited row is the threat here: these two reach a custom property
    // every glass layer on the page is mixed from, and background-image is
    // fetched from silently.
    const layers = backgroundLayers(
      { ...defaultAppearance('x'), background: 'url(javascript:alert(1))', tintLight: 'red', tintDark: '#fff' },
      'light',
    );
    expect(layers).toBeUndefined();
    const half = backgroundLayers({ ...look(), tintLight: 'var(--x); }' }, 'light')!;
    expect(half['--pontis-workspace-bg']).toBeUndefined();
    expect(half.backgroundImage).toContain('url(');
  });
});

describe('surfaceLayers', () => {
  it('reproduces the four documented layers at the default', () => {
    expect(surfaceLayers(DEFAULT_SURFACE_OPACITY)).toEqual({
      '--pontis-glass-surface': '82%',
      '--pontis-glass-field': '80%',
      '--pontis-glass-chrome': '70%',
      '--pontis-glass-firm': '96%',
    });
  });

  it('moves the four together and keeps the steps between them', () => {
    const dialed = surfaceLayers(0.6);
    expect(dialed).toEqual({
      '--pontis-glass-surface': '60%',
      '--pontis-glass-field': '58%',
      '--pontis-glass-chrome': '48%',
      '--pontis-glass-firm': '74%',
    });
    // However thin the reader makes them, the header stays the see-through one
    // and a hovered tile stays firmer than the tile under it.
    expect(Number.parseFloat(dialed['--pontis-glass-chrome']!)).toBeLessThan(
      Number.parseFloat(dialed['--pontis-glass-surface']!),
    );
    expect(Number.parseFloat(dialed['--pontis-glass-firm']!)).toBeGreaterThan(
      Number.parseFloat(dialed['--pontis-glass-surface']!),
    );
  });

  it('cannot be dialled past solid, and takes nonsense as the default', () => {
    expect(surfaceLayers(1)['--pontis-glass-firm']).toBe('100%');
    expect(surfaceLayers(40)['--pontis-glass-surface']).toBe('100%');
    expect(surfaceLayers(-4)['--pontis-glass-surface']).toBe('0%');
    expect(surfaceLayers(Number.NaN)['--pontis-glass-surface']).toBe('82%');
  });

  it('rides along with the rest of the page background', () => {
    const layers = backgroundLayers(
      { ...defaultAppearance('x'), background: PNG, backgroundOpacity: 0.35, surfaceOpacity: 0.5 },
      'light',
    )!;
    expect(layers['--pontis-glass-surface']).toBe('50%');
    expect(layers['--pontis-glass-chrome']).toBe('38%');
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
    // The same guard on the second slider, whose default is not the first one's.
    expect((await saveAppearance(db, 'i:d', { surfaceOpacity: Number.NaN })).surfaceOpacity).toBe(
      DEFAULT_SURFACE_OPACITY,
    );
    expect((await saveAppearance(db, 'i:d', { surfaceOpacity: 0.5 })).surfaceOpacity).toBe(0.5);
    await db.close();
  });

  it('gives a row written before the second slider its own default', async () => {
    const db = await freshDb();
    const legacy = { ...defaultAppearance('i:d') } as Record<string, unknown>;
    delete legacy.surfaceOpacity;
    await db.startPageAppearance.put(legacy as unknown as StartPageAppearanceRecord);
    const kept = await saveAppearance(db, 'i:d', { titleText: '只是改个标题' });
    expect(kept.surfaceOpacity).toBe(DEFAULT_SURFACE_OPACITY);
    // and not the other slider's default, which is a different number.
    expect(kept.backgroundOpacity).toBe(DEFAULT_BACKGROUND_OPACITY);
    await db.close();
  });

  it('keeps the colours read out of the picture, and drops them with it', async () => {
    const db = await freshDb();
    await saveAppearance(db, 'i:d', { background: PNG, tintLight: '#ABC123', tintDark: '#101418' });
    // Normalised on the way in, because the same string reaches the page.
    expect((await loadAppearance(db, 'i:d')).tintLight).toBe('#abc123');

    await saveAppearance(db, 'i:d', { tintLight: 'rgb(1,2,3)' });
    const afterBad = await loadAppearance(db, 'i:d');
    expect(afterBad.tintLight).toBeNull();
    // A patch that names one colour says nothing about the other.
    expect(afterBad.tintDark).toBe('#101418');

    // Clearing is a write of null, not an absence.
    await saveAppearance(db, 'i:d', { tintDark: null });
    expect((await loadAppearance(db, 'i:d')).tintDark).toBeNull();

    // What was read out of a picture has no meaning once the picture is gone.
    await saveAppearance(db, 'i:d', { background: null });
    const bare = await loadAppearance(db, 'i:d');
    expect(bare.tintLight).toBeNull();
    expect(bare.tintDark).toBeNull();
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
