import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MailMessage } from '../../../shared/mail';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { mailApi } from '../../stores/mail';
import { cachedSanitize, mailSrcdoc, type MailTheme } from './sanitize';

// ---------------------------------------------------------------- the app theme for the frame

/** `<html data-theme>` (App.tsx): changes only when the person switches the theme (or the OS does). */
function subscribeTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
const themeName = (): string => document.documentElement.dataset['theme'] ?? 'dark';

let resolved: { name: string; theme: MailTheme } | null = null;

/** The theme's colours resolved to literals (tokens may be `var()` chains), once per theme. */
function resolveTheme(name: string): MailTheme {
  if (resolved?.name === name) return resolved.theme;
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const colour = (token: string): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const theme: MailTheme = { scheme: name === 'light' ? 'light' : 'dark', fg: colour('--color-fg'), muted: colour('--color-muted'), link: colour('--color-accent-text'), line: colour('--color-line') };
  probe.remove();
  resolved = { name, theme };
  return theme;
}

/** Before the content is measured, and the floor for short messages. */
const MIN_HEIGHT = 120;
/** A message taller than this scrolls inside its frame (a runaway layout never grows the page unbounded). */
const MAX_HEIGHT = 40_000;

/**
 * The message HTML in a sandboxed iframe (ADR-0088 §10): `sandbox=""` — no scripts, no same
 * origin, no forms, no popups, no top navigation — and `srcdoc` that starts with the CSP meta;
 * DOMPurify ran before (sanitize.ts, cached per message id, §9). Only the open message renders one.
 * A message without its own colours is drawn in the app theme (transparent page, theme text and
 * links); one that sets them keeps Apple Mail's white page.
 *
 * Height: the frame is opaque to us (no same origin), so the same document is laid out once in a
 * hidden twin with `sandbox="allow-same-origin"` and no `allow-scripts` — it can run nothing, it
 * only lets this page read the twin's `scrollHeight` on `load` (images included); the twin is
 * removed right after. Measured again only when the content, the remote-images choice or the
 * window width changes — no ResizeObserver, no loop. The visible frame keeps `overflow:auto`, so
 * an image that lands later never clips the text.
 */
export function MailFrame({ message, remote }: { message: MailMessage; remote: boolean }): ReactNode {
  const themeKey = useSyncExternalStore(subscribeTheme, themeName);
  const clean = useMemo(() => {
    const api = mailApi();
    const cid = (contentId: string): string | null => {
      const a = message.attachments.find((x) => x.cid === contentId && x.mime.startsWith('image/'));
      return a && api ? api.attachmentUrl(message.id, a.id) : null;
    };
    return cachedSanitize(message.id, message.html ?? '', { remote, cid });
  }, [message, remote]);
  // A message with its own colours keeps the white page; a plain one follows the app theme (§8).
  const themed = !clean.styled;
  const srcdoc = useMemo(() => mailSrcdoc(clean.html, themed ? resolveTheme(themeKey) : null, remote), [clean, themed, themeKey, remote]);
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
    <div ref={box} className={cx('relative mx-2 my-2 overflow-hidden rounded-[8px]', !themed && 'bg-white')} data-themed={themed || undefined}>
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
