import { deriveThumbKey, sealBytes, thumbInfo, type MasterKey } from 'yungle-e2e';

/**
 * A sealed WebP thumbnail for an encrypted image, or null. Ported from the
 * website's `makeSealedThumbnail`: the preview worker holds ciphertext and no
 * key, so the sender's browser is the only party that can make one. Every
 * failure is null — a plain file list beats a failed send.
 */
const MAX_EDGE = 600;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export async function makeSealedThumbnail(file: File, master: MasterKey, fileId: string): Promise<string | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_SOURCE_BYTES) return null;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
    const sealed = await sealBytes(await deriveThumbKey(master, fileId), new Uint8Array(await blob.arrayBuffer()), thumbInfo(fileId));
    let s = '';
    for (const b of sealed) s += String.fromCharCode(b);
    return btoa(s);
  } catch {
    return null;
  }
}
