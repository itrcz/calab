import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MailMessage } from '../../../shared/mail';
import { t } from '../../i18n';
import { mailApi } from '../../stores/mail';
import { cachedSanitize, mailSrcdoc } from './sanitize';

/** Before the content is measured, and the floor for short messages. */
const MIN_HEIGHT = 120;
/** A message taller than this scrolls inside its frame (a runaway layout never grows the page unbounded). */
const MAX_HEIGHT = 40_000;

/**
 * The message HTML in a sandboxed iframe (ADR-0080 §10): `sandbox=""` — no scripts, no same
 * origin, no forms, no popups, no top navigation — and `srcdoc` that starts with the CSP meta;
 * DOMPurify ran before (sanitize.ts, cached per message id, §9). Only the open message renders one.
 *
 * Height: the frame is opaque to us (no same origin), so the same document is laid out once in a
 * hidden twin with `sandbox="allow-same-origin"` and no `allow-scripts` — it can run nothing, it
 * only lets this page read the twin's `scrollHeight` on `load` (images included); the twin is
 * removed right after. Measured again only when the content, the remote-images choice or the
 * window width changes — no ResizeObserver, no loop. The visible frame keeps `overflow:auto`, so
 * an image that lands later never clips the text.
 */
export function MailFrame({ message, remote }: { message: MailMessage; remote: boolean }): ReactNode {
  const srcdoc = useMemo(() => {
    const api = mailApi();
    const cid = (contentId: string): string | null => {
      const a = message.attachments.find((x) => x.cid === contentId && x.mime.startsWith('image/'));
      return a && api ? api.attachmentUrl(message.id, a.id) : null;
    };
    return mailSrcdoc(cachedSanitize(message.id, message.html ?? '', { remote, cid }).html, remote);
  }, [message, remote]);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [width, setWidth] = useState(0);

  // The window width (the frame's width follows it): re-measure after a resize settles.
  useLayoutEffect(() => {
    let timer = 0;
    const onResize = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(box.current?.clientWidth ?? 0), 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    const host = box.current;
    if (!host) return;
    const probe = document.createElement('iframe');
    probe.setAttribute('sandbox', 'allow-same-origin');
    probe.setAttribute('aria-hidden', 'true');
    probe.tabIndex = -1;
    probe.style.cssText = `position:absolute;left:0;top:0;width:${host.clientWidth}px;height:0;border:0;visibility:hidden;pointer-events:none`;
    let alive = true;
    probe.addEventListener(
      'load',
      () => {
        if (!alive) return;
        const doc = probe.contentDocument;
        const h = doc ? Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) : 0;
        if (h > 0) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h) + 2)));
        probe.remove();
      },
      { once: true },
    );
    probe.srcdoc = srcdoc;
    host.appendChild(probe);
    return () => {
      alive = false;
      probe.remove();
    };
  }, [srcdoc, width]);

  return (
    <div ref={box} className="relative mx-2 my-2 overflow-hidden rounded-[8px] bg-white">
      <iframe
        sandbox=""
        srcDoc={srcdoc}
        title={t('mbox.bodyFrame')}
        referrerPolicy="no-referrer"
        className="block w-full border-0"
        style={{ height }}
        data-testid="mail-frame"
      />
    </div>
  );
}
