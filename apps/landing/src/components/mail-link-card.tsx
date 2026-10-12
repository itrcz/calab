'use client';

import { Download, Mail, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dict } from '@/i18n';
import { detectOs, type Os } from '@/lib/detect-os';
import { mailDeepLink, parseMailHash, type MailLinkResult } from '@/lib/mail-link';
import { DOWNLOADS } from '@/lib/site';
import { Button } from './ui';

const isPhone = (): boolean =>
  window.matchMedia('(max-width: 768px)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const downloadHref = (os: Os | null): string =>
  os === 'win' ? DOWNLOADS.win : os === 'linux' ? DOWNLOADS.appImage : DOWNLOADS.macArm64;

/**
 * "Add mail to Calab" card (ADR-0088 §12). Shown when the URL fragment is `#mail=<payload>`. The payload
 * never leaves the page except inside the `calab://` link the visitor clicks; only the fragment is read
 * (a `?mail=` query is ignored on purpose). The password is never decoded into state.
 */
export function MailLinkCard({ t }: { t: Dict['mailLink'] }) {
  const [link, setLink] = useState<MailLinkResult | null>(null);
  const [phone, setPhone] = useState(false);
  const [os, setOs] = useState<Os | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const read = () => {
      const parsed = parseMailHash(window.location.hash);
      setLink(parsed);
      if (parsed) {
        setPhone(isPhone());
        setOs(detectOs());
      }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => {
      window.removeEventListener('hashchange', read);
    };
  }, []);

  useEffect(() => {
    if (link) closeBtn.current?.focus();
  }, [link]);

  const close = useCallback(() => {
    // Drop the fragment (and the password inside it) from the address bar and history entry.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setLink(null);
  }, []);

  if (!link) return null;
  const ok = 'error' in link ? null : link;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 print:hidden"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-link-title"
        className="w-[440px] max-w-full rounded-2xl border border-white/20 bg-card p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="mail-link-title" className="flex items-center gap-2 pt-2 text-[19px] font-semibold">
            <Mail aria-hidden="true" className="size-5 shrink-0" strokeWidth={2} />
            {ok ? t.title : t.broken}
          </h2>
          <button
            ref={closeBtn}
            type="button"
            aria-label={t.close}
            onClick={close}
            className="-mr-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-card-raised"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        {ok && (
          <>
            <p className="mt-3 inline-block max-w-full rounded-full bg-card-raised px-4 py-2 font-mono text-[15px] leading-5 break-all">
              {ok.email}
            </p>
            {ok.hasPassword && <p className="mt-3 text-[14px] leading-6 text-fg-2">{t.passwordNote}</p>}
            {phone ? (
              <p className="mt-4 text-[15px] leading-6 text-fg-2">{t.phone}</p>
            ) : (
              <div className="mt-5 flex flex-col items-stretch gap-3">
                <Button href={mailDeepLink(ok.payload)}>{t.add}</Button>
                <Button href={downloadHref(os)} variant="secondary">
                  <Download aria-hidden="true" className="size-4" strokeWidth={2} />
                  {t.download}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
