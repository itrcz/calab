import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';

/**
 * What a corporate identity screen is for — the static content PlanLock dims below Business
 * (docs/08 «Функции не по тарифу»): no request is made, so nothing can fail.
 */
export function IdentityAbout({ title, text }: { title: MessageKey; text: MessageKey }): ReactNode {
  return (
    <Card title={t(title)}>
      <p className="px-3 py-2.5 text-body text-muted">{t(text)}</p>
    </Card>
  );
}

/**
 * The server has no identity operator configuration (409 IDENTITY_NOT_CONFIGURED, ADR-0054):
 * a normal state of the install, not an error — no retry, no red text.
 */
export function IdentityNotConfigured(): ReactNode {
  return (
    <Card>
      <p className="flex items-start gap-2 px-3 py-2.5 text-body text-muted" data-testid="identity-not-configured">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        {t('identity.notConfigured')}
      </p>
    </Card>
  );
}
