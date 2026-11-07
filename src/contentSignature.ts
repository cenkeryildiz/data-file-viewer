/** Deterministic lightweight signatures shared by the viewer and reference diff engine. */
export const FNV_OFFSET_BASIS = 0x811c9dc5;

export function fnv1aFold(hash: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

