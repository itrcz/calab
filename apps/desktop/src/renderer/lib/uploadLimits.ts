import type { UploadLimits } from '@calaba/protocol';
import type { MessageKey } from '../i18n';

/**
 * The superadmin's upload limits of a workspace as a form (ADR-0155): «Загрузка файлов» in the
 * admin workspace card. Pure, for tests.
 */
export type Field = 'burst' | 'perHour' | 'maxFileMb';
export type UploadForm = Record<Field, string>;

export const UPLOAD_LIMIT_FIELDS: ReadonlyArray<{ field: Field; label: MessageKey }> = [
  { field: 'burst', label: 'admin.uploads.burst' },
  { field: 'perHour', label: 'admin.uploads.perHour' },
  { field: 'maxFileMb', label: 'admin.uploads.maxFile' },
];

/** The server's ranges (apps/server/internal/plans/upload_limits.go); max_file_mb's comes with the workspace. */
const MAX: Record<Exclude<Field, 'maxFileMb'>, number> = { burst: 10000, perHour: 100000 };

export function toUploadForm(l: UploadLimits | undefined): UploadForm {
  const s = (v: number | undefined): string => (v === undefined ? '' : String(v));
  return { burst: s(l?.burst), perHour: s(l?.perHour), maxFileMb: s(l?.maxFileMb) };
}

/**
 * The form as the request's limits: empty = the server default (unset); a value out of 1..max
 * names its field. `cap` is the server's hard cap of one file, MB.
 */
export function uploadLimitsOf(form: UploadForm, cap: number): { limits: { burst?: number; perHour?: number; maxFileMb?: number } } | { error: { field: Field; max: number } } {
  const limits: { burst?: number; perHour?: number; maxFileMb?: number } = {};
  for (const { field } of UPLOAD_LIMIT_FIELDS) {
    const raw = form[field].trim();
    if (!raw) continue;
    const max = field === 'maxFileMb' ? cap : MAX[field];
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1 || v > max) return { error: { field, max } };
    limits[field] = v;
  }
  return { limits };
}
