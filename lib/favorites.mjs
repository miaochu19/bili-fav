import { normalizeMedia } from "./api.mjs";

export const mediaKey = (v) => v.bvid || v.bv_id || `invalid:${v.aid ?? v.id}:${v.title}`;

export function knownInFolder(videos, folderId) {
  return new Set(videos.filter((v) => v.folders?.some((f) => String(f.id) === String(folderId))).map(mediaKey));
}

/** Replace only a successfully scanned folder. Failed/unscanned folders survive. */
export function mergeFolder(byBvid, medias, folder, { complete = false } = {}) {
  if (complete) {
    for (const [key, video] of byBvid) {
      const folders = (video.folders || []).filter((f) => String(f.id) !== String(folder.id));
      if (!folders.length) byBvid.delete(key);
      else byBvid.set(key, { ...video, folders });
    }
  }
  for (const media of medias) {
    const n = normalizeMedia(media, folder), key = mediaKey(n), previous = byBvid.get(key);
    const folders = (previous?.folders || []).filter((f) => String(f.id) !== String(folder.id));
    folders.push({ id: folder.id, title: folder.title });
    byBvid.set(key, { ...previous, ...n, key, folders });
  }
}
