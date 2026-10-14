// What the start page looks like: its title and its background.
//
// Both are local to this browser and never leave it. The image is a private
// choice in the same sense the cached bookmark tree is, so it is stored in the
// same IndexedDB row family as the config and deleted with it — there is no
// upload path for it, and adding one would put a user's wallpaper on the same
// server that already holds their bookmarks for no benefit (§16.3).
//
// The two background colours are read out of that same image, kept in this same
// row, and remain the user's to overrule — tint.ts does the arithmetic.

import type { PontisDB, StartPageAppearanceRecord } from '../store/db';
import type { ChromeStorageArea } from '../../runtime/chromeApi';
import { isStoredTint, normalizeTint, tintsFromPixels, type GroundTints, type Scheme } from './tint';

/** Written to chrome.storage.local beside the IndexedDB row, because IndexedDB
 * has no cross-document event: without this an open start page shows a
 * wallpaper nobody can see until it is reloaded. */
export const APPEARANCE_SIGNAL_KEY = 'pontis:start-page-appearance';

export async function publishAppearanceChange(storage: ChromeStorageArea, id: string): Promise<void> {
  await storage.set({ [APPEARANCE_SIGNAL_KEY]: { id, at: Date.now() } });
}

/** How much of a background is let through when the user has not said. Enough
 * to read as a photograph, not enough to fight the grid for attention. */
export const DEFAULT_BACKGROUND_OPACITY = 0.35;

/** How much of the page's own colour the reading surfaces lay down when the
 * user has not said. The other three layers are stepped off this one. */
export const DEFAULT_SURFACE_OPACITY = 0.82;

/** The distances §0.6 puts between the four layers, in percentage points: the
 * header is chrome and lets the most light through, the search field and the
 * tiles are where words have to be parsed, and a hovered tile firms up. A
 * user-set firmness moves all four by the same amount rather than flattening
 * the steps that make the header read as chrome. */
const SURFACE_STEPS = { field: -2, chrome: -12, firm: 14 };

/** A file bigger than this is not a wallpaper someone took a picture of. */
export const MAX_BACKGROUND_INPUT_BYTES = 8 * 1024 * 1024;

/** The encoded form is what actually gets stored; the cap is on that, because
 * a source file can be large and compress well, or small and not. */
export const MAX_BACKGROUND_DATA_CHARS = 2_000_000;

/** Longest edge after downscaling. Beyond this a background costs storage and
 * decode time without being visibly sharper behind a bookmark grid. */
const MAX_EDGE = 2560;

/** Longest edge of the copy the colour is read from. See tintsFromImageSource. */
const TINT_SAMPLE_EDGE = 96;

/** Raster types only. `image/svg+xml` is deliberately absent: an SVG can pull
 * resources from a remote origin, which is the third-party leak the favicon
 * policy refuses elsewhere (§16.4). */
const ACCEPTED_TYPES = ['image/jpeg', 'image/pjpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp'];

export type BackgroundError = 'not-an-image' | 'source-too-large' | 'could-not-decode' | 'encoded-too-large';

export function defaultAppearance(id: string): StartPageAppearanceRecord {
  return {
    id,
    titleText: '',
    background: null,
    backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
    surfaceOpacity: DEFAULT_SURFACE_OPACITY,
    tintLight: null,
    tintDark: null,
    updatedAt: 0,
  };
}

/** Absent means untouched, not reset: a browser that never configured an
 * appearance should show the greeting on a plain background. */
export async function loadAppearance(db: PontisDB, id: string): Promise<StartPageAppearanceRecord> {
  const row = await db.startPageAppearance.get(id);
  return row ?? defaultAppearance(id);
}

export async function saveAppearance(
  db: PontisDB,
  id: string,
  patch: Partial<
    Pick<
      StartPageAppearanceRecord,
      'titleText' | 'background' | 'backgroundOpacity' | 'surfaceOpacity' | 'tintLight' | 'tintDark'
    >
  >,
): Promise<StartPageAppearanceRecord> {
  const current = await loadAppearance(db, id);
  const next: StartPageAppearanceRecord = {
    ...current,
    ...patch,
    // Whatever the row claims, only a colour in the one form the page may
    // substitute into its glass layers is kept. `in` rather than `??`, because
    // clearing a colour is a write of null and must not read as "untouched".
    tintLight: normalizeTint('tintLight' in patch ? patch.tintLight : current.tintLight),
    tintDark: normalizeTint('tintDark' in patch ? patch.tintDark : current.tintDark),
    backgroundOpacity: clampOpacity(patch.backgroundOpacity ?? current.backgroundOpacity, DEFAULT_BACKGROUND_OPACITY),
    surfaceOpacity: clampOpacity(patch.surfaceOpacity ?? current.surfaceOpacity, DEFAULT_SURFACE_OPACITY),
    updatedAt: Date.now(),
  };
  // A colour read out of a picture is not the picture's own possession: when the
  // wallpaper goes, what was taken from it goes with it, and the page returns to
  // the theme's background rather than keeping a tint nobody can explain.
  if (next.background === null) {
    next.tintLight = null;
    next.tintDark = null;
  }
  await db.startPageAppearance.put(next);
  return next;
}

function clampOpacity(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** The time-of-day greeting shown when the user has not typed a title. */
export function greetingFor(at: Date): string {
  const hour = at.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function titleFor(appearance: StartPageAppearanceRecord, at: Date): string {
  const custom = appearance.titleText.trim();
  return custom || greetingFor(at);
}

/** Only a value this module produced may reach a `url()`. The stored string is
 * read back from IndexedDB, where a hand-edited or truncated row could hold
 * anything, and `background-image` is a place an external URL would be fetched
 * from silently with no visible symptom (§16.1). */
export function isStoredBackground(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:webp|jpeg|png|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
}

/** How much of the page colour each glass layer lays over a background, from
 * one number the reader sets. Exported for the same reason the rest of the
 * module's arithmetic is: it is the whole of what the slider means. */
export function surfaceLayers(opacity: number): Record<string, string> {
  const percent = clampOpacity(opacity, DEFAULT_SURFACE_OPACITY) * 100;
  const step = (delta: number) => `${Math.round(Math.min(100, Math.max(0, percent + delta)))}%`;
  return {
    '--pontis-glass-surface': step(0),
    '--pontis-glass-field': step(SURFACE_STEPS.field),
    '--pontis-glass-chrome': step(SURFACE_STEPS.chrome),
    '--pontis-glass-firm': step(SURFACE_STEPS.firm),
  };
}

/** Layered onto the page's own colour so the image reads through a veil rather
 * than sitting under unreadable text. The veil is the ground at (1 - opacity),
 * which keeps light and dark schemes honest without a second setting for each:
 * the ground itself is the colour read out of the picture when there is one,
 * and the theme's own when there is not.
 *
 * `scheme` decides which of the two stored colours is meant, and is the page's
 * computed scheme rather than a preference stored alongside them — the pair is
 * one decision, not two wallpapers. */
export function backgroundLayers(
  appearance: StartPageAppearanceRecord,
  scheme: Scheme,
): Record<string, string> | undefined {
  if (!isStoredBackground(appearance.background)) return undefined;
  const layers: Record<string, string> = { ...surfaceLayers(appearance.surfaceOpacity) };

  const ground = scheme === 'dark' ? appearance.tintDark : appearance.tintLight;
  // Substituted into every glass layer on the page, so a hand-edited row has to
  // be the plain hex colour this module writes and nothing else.
  if (isStoredTint(ground)) layers['--pontis-workspace-bg'] = ground;

  if (appearance.backgroundOpacity > 0) {
    const veil = Math.round((1 - appearance.backgroundOpacity) * 100);
    const veilColor = `color-mix(in srgb, var(--pontis-workspace-bg) ${veil}%, transparent)`;
    layers.backgroundImage = `linear-gradient(${veilColor}, ${veilColor}), url("${appearance.background}")`;
    layers.backgroundSize = 'cover';
    layers.backgroundPosition = 'center';
    layers.backgroundRepeat = 'no-repeat';
    // Fixed, so the background belongs to the browser window rather than
    // scrolling away with a long folder.
    layers.backgroundAttachment = 'fixed';
  }

  return Object.keys(layers).length > 0 ? layers : undefined;
}

export function validateBackgroundInput(file: { type: string; size: number }): BackgroundError | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return 'not-an-image';
  if (file.size > MAX_BACKGROUND_INPUT_BYTES) return 'source-too-large';
  return null;
}

/**
 * Turn a picked file into something safe to store: decoded, downscaled and
 * re-encoded, so a 12-megapixel phone photo costs a few hundred kilobytes and
 * whatever metadata it carried (GPS, orientation, the camera's name) is gone.
 *
 * The colour comes back with it, read from the same decoded bitmap: a file that
 * cannot be decoded for one has nothing to say about the other.
 */
export async function prepareBackground(
  file: File,
): Promise<{ dataUrl: string; tints: GroundTints | null } | { error: BackgroundError }> {
  const invalid = validateBackgroundInput(file);
  if (invalid) return { error: invalid };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: 'could-not-decode' };
  }

  try {
    const tints = tintsFromImageSource(bitmap, bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let dataUrl = canvas.toDataURL('image/webp', 0.82);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    if (!isStoredBackground(dataUrl) || dataUrl.length > MAX_BACKGROUND_DATA_CHARS) {
      return { error: 'encoded-too-large' };
    }
    return { dataUrl, tints };
  } finally {
    bitmap.close();
  }
}

/**
 * The dominant colour of anything already decoded — a bitmap from a picked file,
 * or an image loaded back from what this module stored.
 *
 * Sampled at 96px across the longest edge: enough pixels to average a hue over,
 * few enough that choosing a wallpaper never blocks the settings page.
 */
export function tintsFromImageSource(
  source: CanvasImageSource,
  width: number,
  height: number,
): GroundTints | null {
  if (width < 1 || height < 1) return null;
  const scale = Math.min(1, TINT_SAMPLE_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return tintsFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

/** Read the colour out of a stored background again — the button for after a
 * hand-edited colour stopped matching the picture it came from. */
export async function tintsFromStoredBackground(dataUrl: unknown): Promise<GroundTints | null> {
  if (!isStoredBackground(dataUrl)) return null;
  const image = new Image();
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    return null;
  }
  return tintsFromImageSource(image, image.naturalWidth, image.naturalHeight);
}

export const BACKGROUND_ERROR_TEXT: Record<BackgroundError, string> = {
  'not-an-image': '只能使用 JPG、PNG、WebP、GIF、AVIF 或 BMP 图片（不支持 SVG）。',
  'source-too-large': '图片太大了，请选择 8 MB 以内的文件。',
  'could-not-decode': '这张图片没能读取，可能已经损坏或格式不符。',
  'encoded-too-large': '这张图片压缩后仍然太大，请换一张或裁小一些。',
};
