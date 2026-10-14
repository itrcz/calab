import { useId, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { t } from '../i18n';
import { Button, Input, Modal } from './ui';

/** The text field of a prompt (e.g. the reason of a ban); filling it is optional. */
export interface PromptField {
  label: string;
  placeholder?: string;
  maxLength?: number;
}

interface ConfirmState {
  req: {
    title: string;
    text: string;
    action: string;
    tone: 'destructive' | 'primary';
    field?: PromptField | undefined;
    resolve: (ok: boolean, value: string) => void;
  } | null;
}

const useConfirm = create<ConfirmState>()(() => ({ req: null }));

function ask(req: NonNullable<ConfirmState['req']>): void {
  useConfirm.getState().req?.resolve(false, ''); // a newer request replaces an open one
  useConfirm.setState({ req });
}

/** In-app confirmation (no native window.confirm). `tone: 'primary'` for non-destructive actions. */
export function confirmAction(title: string, text: string, action: string, tone: 'destructive' | 'primary' = 'destructive'): Promise<boolean> {
  return new Promise((resolve) => ask({ title, text, action, tone, resolve: (ok) => resolve(ok) }));
}

/** A confirmation with one text field: resolves to the trimmed text, or null when cancelled. */
export function promptAction(title: string, text: string, action: string, field: PromptField, tone: 'destructive' | 'primary' = 'destructive'): Promise<string | null> {
  return new Promise((resolve) => ask({ title, text, action, tone, field, resolve: (ok, value) => resolve(ok ? value.trim() : null) }));
}

export function ConfirmHost(): ReactNode {
  const req = useConfirm((s) => s.req);
  const [value, setValue] = useState('');
  const fieldId = useId();
  const close = (ok: boolean): void => {
    req?.resolve(ok, value);
    useConfirm.setState({ req: null });
    setValue('');
  };
  return (
    <Modal
      open={req !== null}
      onClose={() => close(false)}
      title={req?.title ?? ''}
      closeButton={false}
      footer={
        <>
          {/* Primary-tone prompts guard external triggers (deep links): Enter must not accept. */}
          <Button variant="secondary" onClick={() => close(false)} autoFocus={req?.tone === 'primary' && !req.field}>
            {t('common.cancel')}
          </Button>
          <Button variant={req?.tone === 'primary' ? 'primary' : 'destructive'} onClick={() => close(true)} autoFocus={req?.tone !== 'primary' && !req?.field}>
            {req?.action}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line text-muted">{req?.text}</p>
      {req?.field ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <label htmlFor={fieldId} className="text-caption font-medium text-muted">
            {req.field.label}
          </label>
          <Input
            id={fieldId}
            autoFocus
            value={value}
            maxLength={req.field.maxLength}
            placeholder={req.field.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                close(true);
              }
            }}
            data-testid="prompt-field"
          />
        </div>
      ) : null}
    </Modal>
  );
}
