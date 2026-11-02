import type { AdminWorkspace } from '@calaba/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Button, Card, Input, Row } from '../../components/ui';
import { t } from '../../i18n';
import { adminApi } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { UPLOAD_LIMIT_FIELDS, toUploadForm, uploadLimitsOf, type UploadForm } from '../../lib/uploadLimits';
import { toast } from '../../stores/toasts';

/**
 * «Загрузка файлов» in the admin workspace card (ADR-0155): the superadmin's overrides of the
 * upload limits per member — at once, per hour, one file's size. An empty field follows the
 * server default, shown as the placeholder. Applies to the next upload; logged on the server.
 */
export function UploadLimitsCard({ a, onSaved }: { a: AdminWorkspace; onSaved: (a: AdminWorkspace) => void }): ReactNode {
  const qc = useQueryClient();
  const id = a.workspace?.id ?? '';
  const saved = toUploadForm(a.uploadLimits);
  const [form, setForm] = useState<UploadForm>(saved);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (limits: { burst?: number; perHour?: number; maxFileMb?: number }) => adminApi.setUploadLimits(id, limits),
    onSuccess: (r) => {
      if (r.workspace) {
        onSaved(r.workspace);
        setForm(toUploadForm(r.workspace.uploadLimits));
      }
      toast.success(t('admin.uploads.saved'));
      void qc.invalidateQueries({ queryKey: ['admin', 'search'] });
    },
    onError: (e) => setError(errorText(e, t('err.ctx.save'))),
  });
  if (!id) return null;
  const cap = a.maxFileMbCap || 4096;
  const defaults = toUploadForm(a.uploadDefaults);
  const changed = UPLOAD_LIMIT_FIELDS.some(({ field }) => form[field].trim() !== saved[field]);

  const submit = (): void => {
    setError(null);
    const r = uploadLimitsOf(form, cap);
    if ('error' in r) {
      const label = UPLOAD_LIMIT_FIELDS.find((f) => f.field === r.error.field)?.label ?? 'admin.uploads.burst';
      setError(t('admin.uploads.range', { field: t(label), max: r.error.max }));
      return;
    }
    save.mutate(r.limits);
  };

  return (
    <Card title={t('admin.card.uploads')} footer={t('admin.uploads.hint', { cap })}>
      {UPLOAD_LIMIT_FIELDS.map(({ field, label }) => (
        <Row key={field} label={t(label)}>
          <Input
            aria-label={t(label)}
            inputMode="numeric"
            className="w-28 text-right tabular-nums"
            placeholder={defaults[field]}
            value={form[field]}
            onChange={(e) => setForm({ ...form, [field]: e.target.value.replace(/[^\d]/g, '') })}
            data-testid={`admin-upload-${field}`}
          />
        </Row>
      ))}
      {error || changed ? (
        <div className="flex items-center justify-end gap-3 px-3 py-2">
          {error ? (
            <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
              {error}
            </span>
          ) : null}
          {changed ? (
            <Button size="sm" busy={save.isPending} onClick={submit} data-testid="admin-upload-save">
              {t('common.save')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
