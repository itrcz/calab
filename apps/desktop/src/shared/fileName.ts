/**
 * Safe local file names for downloaded attachments (the name comes from another user).
 * Pure (no Node) so it is unit-tested; main joins the result with the Downloads folder.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
const MAX_NAME = 200;

export function safeFileName(name: string): string {
  // Only the last path segment, whatever the separator (a name is never a path).
  const base = name.split(/[\\/]/).pop() ?? '';
  let s = base
    // eslint-disable-next-line no-control-regex -- strip control chars from user-supplied file names
    .replace(/[:*?"<>|\u0000-\u001f\u007f]/g, '_')
    // Bidi overrides / isolates / marks: «photo‮gpj.exe» would show as «photoexe.jpg».
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    // Windows drops trailing dots / spaces (a.exe. → a.exe): never let the OS rewrite the name.
    .replace(/[. ]+$/, '');
  if (/^\.*$/.test(s)) return 'file'; // '', '.', '..'
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  if (s.length > MAX_NAME) {
    const ext = extOf(s);
    s = s.slice(0, MAX_NAME - ext.length) + ext;
  }
  return s;
}

/** `.ext` of a name (last dot, not a leading one), or ''. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 && name.length - i <= 16 ? name.slice(i) : '';
}

/** `name`, `name (1)`, `name (2)` … with the extension kept last. */
export function numberedName(safe: string, n: number): string {
  if (n === 0) return safe;
  const ext = extOf(safe);
  return `${safe.slice(0, safe.length - ext.length)} (${n})${ext}`;
}
