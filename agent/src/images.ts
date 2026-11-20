/** Image formats every provider's vision input takes, recognised by their bytes, not by a name. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((b, i) => bytes[at + i] === b);

/** The media type of PNG, JPEG, GIF or WebP bytes; null for anything else (SVG, HEIC, a mesh). */
export function imageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}
