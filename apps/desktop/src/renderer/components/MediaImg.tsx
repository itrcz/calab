import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { densitySrcSet, pickByDensity } from '../lib/thumbs';
import { platform } from '../platform';

/**
 * URL for an API media path. Electron: synchronous `calaba-api://` URL (main adds auth).
 * Web: an authenticated fetch turned into a cached blob: URL; `onError` hears a failed fetch
 * (Electron: the <img>'s own error event).
 */
export function useMediaUrl(path: string | null | undefined, onError?: () => void): string | undefined {
  // Anonymous routes (a public wiki page's pictures, ADR-0096 §6) need no token: a plain URL, no
  // blob cache — whose entries a sign-out / boot swap would cancel under an anonymous visitor.
  const open = path?.startsWith('/api/public/') ? `${platform.apiBase}${path}` : undefined;
  const [url, setUrl] = useState<string | undefined>(() => (path && platform.directMedia ? `${platform.apiBase}${path}` : undefined));
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  });
  useEffect(() => {
    if (!path || open) return;
    let alive = true;
    void platform.mediaUrl(path).then(
      (u) => {
        if (alive) setUrl(u);
      },
      () => {
        if (alive) failed.current?.();
      },
    );
    return () => {
      alive = false;
    };
  }, [path, open]);
  return path ? (open ?? url) : undefined;
}

/**
 * <img> for an API media path (files, thumbnails, avatars, icons). `hiDpiPath` is the same
 * picture for 2× screens: a 1x/2x srcset where URLs load directly (Electron), otherwise one of
 * the two chosen by devicePixelRatio (web, blob URLs).
 */
export function MediaImg({
  path,
  hiDpiPath,
  ...rest
}: { path: string; hiDpiPath?: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'>): ReactNode {
  const direct = platform.directMedia;
  const src = useMediaUrl(hiDpiPath && !direct ? pickByDensity(path, hiDpiPath, window.devicePixelRatio || 1) : path);
  const srcSet = hiDpiPath && direct ? densitySrcSet(`${platform.apiBase}${path}`, `${platform.apiBase}${hiDpiPath}`) : undefined;
  return src ? <img src={src} srcSet={srcSet} {...rest} /> : <span className={rest.className} aria-hidden />;
}
