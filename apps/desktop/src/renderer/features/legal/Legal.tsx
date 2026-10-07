import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { LegalTexts } from '../../../shared/ipc';
import { Button, Card, Modal, Row, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';

/**
 * Licence attribution (LICENSE: Business Source License 1.1; NOTICE requires the
 * «Powered by GPTunneL» attribution in the UI). The vendor link is legal attribution
 * content, not a server endpoint, so it lives here rather than in env configuration.
 */
export const VENDOR = 'GPTunneL';
export const VENDOR_URL = 'https://gptunnel.ai';
export const LICENSE_EMAIL = 'it@gptunnel.ai';

/** «© 2026 GPTunneL · Powered by GPTunneL» — the vendor name opens the site. */
export function Attribution({ className }: { className?: string }): ReactNode {
  const open = (): void => void platform.app.openExternal(VENDOR_URL);
  return (
    <p className={cx('text-caption text-muted', className)}>
      © 2026 {VENDOR} · {t('legal.poweredBy')}{' '}
      <button type="button" onClick={open} className="text-accent-text hover:underline">
        {VENDOR}
      </button>
    </p>
  );
}

type Doc = 'license' | 'commercial' | 'thirdParty';

function useLegal(enabled: boolean): { data: LegalTexts | undefined; isLoading: boolean } {
  return useQuery({ queryKey: ['legal'], queryFn: () => platform.app.legal(), enabled, staleTime: Infinity });
}

/** Full text of a licence document in a scrollable sheet. */
export function LegalViewer({ doc, onClose }: { doc: Doc; onClose: () => void }): ReactNode {
  const q = useLegal(true);
  const text =
    doc === 'license'
      ? [q.data?.license, q.data?.notice].filter(Boolean).join('\n\n' + '─'.repeat(40) + '\n\n')
      : doc === 'commercial'
        ? (q.data?.commercial ?? '')
        : (q.data?.thirdParty ?? '');
  const title = doc === 'license' ? t('legal.licenseTitle') : doc === 'commercial' ? t('legal.commercialTitle') : t('legal.thirdPartyTitle');
  return (
    <Modal open wide onClose={onClose} title={title}>
      {q.isLoading ? (
        <div className="grid h-40 place-items-center">
          <Spinner className="size-6" />
        </div>
      ) : text ? (
        <pre className="selectable max-h-[min(60vh,520px)] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-card)] bg-elev p-3 font-mono text-caption text-fg">
          {text}
        </pre>
      ) : (
        <p className="text-body text-muted">{t('legal.unavailable')}</p>
      )}
    </Modal>
  );
}

/** «О программе» → «Лицензия» card. */
export function LicenseCard(): ReactNode {
  const [doc, setDoc] = useState<Doc | null>(null);
  return (
    <>
      <Card title={t('legal.card')}>
        <Row label={t('legal.busl')} hint={t('legal.buslHint')}>
          <Button variant="secondary" onClick={() => setDoc('license')}>
            {t('legal.read')}
          </Button>
        </Row>
        <Row label={t('legal.commercial')} hint={t('legal.commercialHint', { email: LICENSE_EMAIL })}>
          <Button variant="secondary" onClick={() => setDoc('commercial')}>
            {t('legal.terms')}
          </Button>
        </Row>
        <Row label={t('legal.thirdParty')}>
          <Button variant="secondary" onClick={() => setDoc('thirdParty')}>
            {t('legal.open')}
          </Button>
        </Row>
      </Card>
      <Attribution className="text-center" />
      {doc ? <LegalViewer doc={doc} onClose={() => setDoc(null)} /> : null}
    </>
  );
}

/** Login screen footer (web and desktop): attribution + licence line + third-party notices. */
export function AuthLegalFooter({ className }: { className?: string } = {}): ReactNode {
  const [doc, setDoc] = useState<Doc | null>(null);
  return (
    <footer className={cx("flex flex-col items-center gap-0.5 text-center", className)}>
      <Attribution />
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-caption text-muted mobile:flex-col mobile:gap-0">
        <button type="button" onClick={() => setDoc('license')} className="hover:text-fg hover:underline mobile:py-0.5">
          {t('legal.footerLicense')}
        </button>
        <span aria-hidden className="mobile:hidden">
          ·
        </span>
        <button type="button" onClick={() => setDoc('thirdParty')} className="hover:text-fg hover:underline mobile:py-0.5">
          {t('legal.thirdParty')}
        </button>
      </p>
      {doc ? <LegalViewer doc={doc} onClose={() => setDoc(null)} /> : null}
    </footer>
  );
}
