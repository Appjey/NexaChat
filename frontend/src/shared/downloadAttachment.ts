// Native-platform download for E2E attachments.
//
// On the web, `<a href={blobUrl} download={fileName}>` is enough — the
// browser routes the click through its download manager. The Capacitor
// Android WebView does NOT honour `download`: nothing happens, the file
// stays inside the WebView's memory. So on native we have to manually:
//   1. Write the decrypted Blob to a user-visible directory.
//   2. Tell the user where it landed via a toast (the caller renders it).
//
// We try in this order:
//   * Custom DownloadsPlugin → MediaStore.Downloads (Android 10+):
//       Drops the file in /storage/emulated/0/Download/ exactly like a
//       browser would, with the system "Download complete" notification.
//       No permissions needed — MediaStore.Downloads is Google's
//       sanctioned API for non-file-manager apps to write to /Download.
//   * Directory.Documents + Messenger/<file>:
//       /storage/emulated/0/Documents/Messenger/<file>. Public collection,
//       writable by any app to its own subdir without runtime permission.
//       Fallback for Android < 10 (where MediaStore.Downloads doesn't
//       exist) and for the rare case the MediaStore call itself fails.
//   * Cache + @capacitor/share — last-resort if even Documents fails
//     (extremely locked-down ROMs).

import { log } from './log'
import { Downloads } from './nativeDownloads'
import { isNative } from './platform'

/** Strip path-traversal characters from a user-supplied filename so we can
 *  pass it as `path` to writeFile without escaping out of the target dir. */
function sanitizeFileName(name: string): string {
  // Drop any directory components and dotdot — keep just the basename.
  // Falls back to "file" if everything got stripped.
  const cleaned = name.replace(/[/\\]/g, '_').replace(/\.\./g, '_').trim()
  return cleaned || 'file'
}

/** Encode a Blob as base64 in 64KB chunks. Avoids building a giant binary
 *  string in one go (btoa on a multi-MB string causes UI jank). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x10000 // 64 KB
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[])
  }
  return btoa(binary)
}

export type NativeDownloadResult =
  | { ok: true; savedTo: 'download' | 'documents'; humanPath: string }
  | { ok: true; savedTo: 'shared' }
  | { ok: false; error: string }

/**
 * Saves a decrypted attachment Blob to a user-visible location on the device.
 * No-op on web (caller should let the default `<a download>` behaviour run).
 *
 * Returns a result describing where the file went so the caller can render
 * the right toast. Never throws — errors are wrapped into `{ ok: false }`.
 */
export async function downloadAttachmentNative(
  blob: Blob,
  fileName: string,
  mimeType: string = 'application/octet-stream',
): Promise<NativeDownloadResult> {
  if (!isNative()) return { ok: false, error: 'not native' }

  const safeName = sanitizeFileName(fileName)
  const base64 = await blobToBase64(blob)

  // Primary: our custom DownloadsPlugin → MediaStore.Downloads on Android
  // 10+. Lands the file in /storage/emulated/0/Download/ exactly like a
  // browser, with the system "Download complete" notification, no perms.
  // Rejects with "unsupported_api" on Android < 10 → we fall through.
  try {
    const res = await Downloads.saveToDownloads({ data: base64, fileName: safeName, mimeType })
    return { ok: true, savedTo: 'download', humanPath: res.path }
  } catch (err) {
    log.warn('MediaStore Downloads failed, trying Documents:', err)
  }

  const { Filesystem, Directory } = await import('@capacitor/filesystem')

  // Fallback: public Documents/Messenger/<file>. Works without runtime
  // permission on Android 11+ because /Documents is a public MediaStore
  // collection and we're writing to our own subdir.
  try {
    await Filesystem.writeFile({
      path: `Messenger/${safeName}`,
      data: base64,
      directory: Directory.Documents,
      recursive: true,
    })
    return { ok: true, savedTo: 'documents', humanPath: `Documents/Messenger/${safeName}` }
  } catch (err) {
    log.warn('Documents write failed, falling back to share sheet:', err)
  }

  // Last resort: write to app cache + invoke the share sheet so the user
  // can route the file wherever they want. Worse UX (extra sheet) but
  // cache writes can't fail for permission reasons.
  try {
    const written = await Filesystem.writeFile({
      path: safeName,
      data: base64,
      directory: Directory.Cache,
      recursive: true,
    })
    const { Share } = await import('@capacitor/share')
    await Share.share({
      title: safeName,
      url: written.uri,
      dialogTitle: 'Сохранить файл',
    })
    return { ok: true, savedTo: 'shared' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
