// What the start page looks like: its title and its background.
//
// Both are local to this browser and never leave it. The image is a private
// choice in the same sense the cached bookmark tree is, so it is stored in the
// same IndexedDB row family as the config and deleted with it — there is no
// upload path for it, and adding one would put a user's wallpaper on the same
// server that already holds their bookmarks for no benefit (§16.3).

import type { PontisDB, StartPageAppearanceRecord } from '../store/db';
import type { ChromeStorageArea } from '../../runtime/chromeApi';

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

/** A file bigger than this is not a wallpaper someone took a picture of. */
export const MAX_BACKGROUND_INPUT_BYTES = 8 * 1024 * 1024;

/** The encoded form is what actually gets stored; the cap is on that, because
 * a source file can be large and compress well, or small and not. */
export const MAX_BACKGROUND_DATA_CHARS = 2_000_000;

/** Longest edge after downscaling. Beyond this a background costs storage and
 * decode time without being visibly sharper behind a bookmark grid. */
const MAX_EDGE = 2560;

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
  patch: Partial<Pick<StartPageAppearanceRecord, 'titleText' | 'background' | 'backgroundOpacity'>>,
): Promise<StartPageAppearanceRecord> {
  const current = await loadAppearance(db, id);
  const next: StartPageAppearanceRecord = {
    ...current,
    ...patch,
    backgroundOpacity: clampOpacity(patch.backgroundOpacity ?? current.backgroundOpacity),
    updatedAt: Date.now(),
  };
  await db.startPageAppearance.put(next);
  return next;
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_OPACITY;
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

/** Layered onto the page's own colour so the image reads through a veil rather
 * than sitting under unreadable text. The veil is the theme's background at
 * (1 - opacity), which keeps light and dark schemes honest without a second
 * setting for each. */
export function backgroundLayers(appearance: StartPageAppearanceRecord): Record<string, string> | undefined {
  if (!isStoredBackground(appearance.background)) return undefined;
  if (appearance.backgroundOpacity <= 0) return undefined;
  const veil = Math.round((1 - appearance.backgroundOpacity) * 100);
  const veilColor = `color-mix(in srgb, var(--pontis-workspace-bg) ${veil}%, transparent)`;
  return {
    backgroundImage: `linear-gradient(${veilColor}, ${veilColor}), url("${appearance.background}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    // Fixed, so the background belongs to the browser window rather than
    // scrolling away with a long folder.
    backgroundAttachment: 'fixed',
  };
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
 */
export async function prepareBackground(file: File): Promise<{ dataUrl: string } | { error: BackgroundError }> {
  const invalid = validateBackgroundInput(file);
  if (invalid) return { error: invalid };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: 'could-not-decode' };
  }

  try {
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
    return { dataUrl };
  } finally {
    bitmap.close();
  }
}

export const BACKGROUND_ERROR_TEXT: Record<BackgroundError, string> = {
  'not-an-image': '只能使用 JPG、PNG、WebP、GIF、AVIF 或 BMP 图片（不支持 SVG）。',
  'source-too-large': '图片太大了，请选择 8 MB 以内的文件。',
  'could-not-decode': '这张图片没能读取，可能已经损坏或格式不符。',
  'encoded-too-large': '这张图片压缩后仍然太大，请换一张或裁小一些。',
};
