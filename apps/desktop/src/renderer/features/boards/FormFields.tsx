import { create } from '@bufbuild/protobuf';
import { BoardFormAnswerSchema, BoardFormFieldType as Kind, type BoardFormAnswer, type BoardFormField } from '@calaba/protocol';
import { useState, type ReactNode } from 'react';
import { Button, Input, Select } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';

export const formControl = 'w-full rounded-[var(--radius-control)] border border-line bg-elev px-3 py-2 text-body text-fg';
export function formError(e: unknown): string {
  return e instanceof ApiError && e.reason === 'FORM_CHANGED' ? t('forms.changed') : t('forms.error');
}

export function FormFields({
  fields,
  submit,
  preview = false,
}: {
  fields: BoardFormField[];
  submit: (answers: BoardFormAnswer[]) => Promise<unknown>;
  preview?: boolean;
}): ReactNode {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [bad, setBad] = useState('');
  if (done)
    return (
      <div role="status" className="py-8 text-center text-headline">
        {t(preview ? 'forms.previewSuccess' : 'forms.success')}
      </div>
    );
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        setBad('');
        void submit(
          fields.map((f) =>
            create(BoardFormAnswerSchema, {
              fieldId: f.id,
              value: values[f.id] ?? (f.type === Kind.CHECKBOX ? 'false' : ''),
            }),
          ),
        )
          .then(() => setDone(true))
          .catch((err: unknown) => {
            setError(formError(err));
            if (err instanceof ApiError) setBad(err.field ?? '');
          })
          .finally(() => setBusy(false));
      }}
    >
      {preview ? <p className="rounded-[var(--radius-card)] bg-hover p-3 text-caption text-muted">{t('forms.previewHint')}</p> : null}
      {fields.map((f) => {
        const id = `form-field-${f.id}`;
        const value = values[f.id] ?? '';
        const update = (v: string): void => setValues((old) => ({ ...old, [f.id]: v }));
        const props = {
          id,
          required: f.required,
          'aria-invalid': bad === f.id,
          'aria-describedby': `${id}-hint`,
          disabled: busy,
        };
        return (
          <div key={f.id} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-body font-medium">
              {f.label}
              {f.required ? ' *' : ''}
            </label>
            {f.type === Kind.PARAGRAPH ? (
              <textarea
                {...props}
                className={`${formControl} !rounded-[var(--radius-card)]`}
                rows={4}
                maxLength={2000}
                placeholder={f.placeholder}
                value={value}
                onChange={(e) => update(e.target.value)}
              />
            ) : f.type === Kind.SELECT ? (
              <Select {...props} value={value} onChange={(e) => update(e.target.value)}>
                <option value="">{f.placeholder || '—'}</option>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : f.type === Kind.CHECKBOX ? (
              <input
                {...props}
                type="checkbox"
                className="size-5 accent-[var(--color-accent)]"
                checked={value === 'true'}
                onChange={(e) => update(String(e.target.checked))}
              />
            ) : (
              <Input
                {...props}
                type={f.type === Kind.EMAIL ? 'email' : f.type === Kind.NUMBER ? 'number' : f.type === Kind.DATE ? 'date' : 'text'}
                step="any"
                maxLength={2000}
                placeholder={f.placeholder}
                value={value}
                onChange={(e) => update(e.target.value)}
              />
            )}
            <p id={`${id}-hint`} className={bad === f.id ? 'text-caption text-danger-text' : 'text-caption text-muted'}>
              {bad === f.id ? error : f.hint}
            </p>
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="text-body text-danger-text">
          {error}
        </p>
      ) : null}
      <Button type="submit" busy={busy} className="self-start">
        {t('forms.submit')}
      </Button>
    </form>
  );
}
