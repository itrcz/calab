import { Upload } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { IMAGE_ACCEPT, avatarFile } from '../lib/image';
import { toast } from '../stores/toasts';
import { Button } from './ui';

/*
 * The avatar picker of the own profile, shared with bots (docs/09 #87): a hidden image input,
 * «Загрузить аватар» and «Убрать». The picked picture is never uploaded as it is: lib/image
 * decodes it (HEIC too) and makes the 512×512 WebP (JPEG fallback) the server takes (≤ 512 KB).
 */

/** A hidden `<input type=file accept=image/*,.heic>`: render `input`, call `open()` to pick. */
export function useImagePicker(onPick: (file: File) => void): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const open = useCallback(() => ref.current?.click(), []);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={IMAGE_ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onPick(f);
        e.target.value = '';
      }}
    />
  );
  return { open, input };
}

/** «Загрузить аватар» (busy while uploading) and, when there is one, «Убрать». */
export function AvatarButtons({
  hasAvatar,
  onUpload,
  onRemove,
  removeLabel = t('profile.removeAvatar'),
  uploadLabel = t('profile.avatar'),
  size = 'md',
  testId,
}: {
  hasAvatar: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  removeLabel?: string;
  uploadLabel?: string;
  size?: 'sm' | 'md';
  testId?: string;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const picker = useImagePicker((f) => {
    setBusy(true);
    avatarFile(f)
      .then(onUpload)
      .catch((e: unknown) => toast.fail(e, t('err.ctx.upload')))
      .finally(() => setBusy(false));
  });
  return (
    <div className="flex gap-2">
      <Button variant="secondary" size={size} busy={busy} onClick={picker.open} data-testid={testId ? `${testId}-upload` : undefined}>
        <Upload className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden /> {uploadLabel}
      </Button>
      {hasAvatar ? (
        <Button
          variant="destructive"
          size={size}
          onClick={() => void onRemove().catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
          data-testid={testId ? `${testId}-remove` : undefined}
        >
          {removeLabel}
        </Button>
      ) : null}
      {picker.input}
    </div>
  );
}
