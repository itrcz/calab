import { PresenceStatus } from '@calaba/protocol';
import { LogOut } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { thumbnailPath } from '../lib/api/endpoints';
import { MediaImg } from './MediaImg';
import { GLYPH_FILL, presenceDotGeometry, presenceGlyph, type PresenceGlyph } from './presenceDot';
import { useWorkspaces } from '../stores/workspaces';
import { cx } from './ui';

// Identity colours (tokens --avatar-1…8): white initials ≥ 4.5:1 on each.
const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--avatar-${i + 1})`);

/** The identity colour of a user (the initial's background; the profile banner, docs/09 #20). */
export function avatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] ?? 'var(--avatar-1)';
}

/**
 * The presence dot (docs/08 «Присутствие», docs/09 #29): overlaps the avatar at the bottom right
 * (centre on the circle at 45°) inside a cutout ring of the surface colour; the glyph — green dot,
 * yellow moon, red dot with a bar, grey ring — is cut with the same colour (`--dot-ring`).
 */
function PresenceDot({ status, size, ring }: { status: PresenceStatus | undefined; size: number; ring: string | undefined }): ReactNode {
  const g = presenceGlyph(status);
  const { dot, ring: border, offset } = presenceDotGeometry(size);
  const style = {
    width: dot,
    height: dot,
    right: offset,
    bottom: offset,
    borderWidth: border,
    '--dot-ring': ring ?? 'var(--color-side)',
  } as CSSProperties;
  return (
    <span data-presence={g} aria-hidden className={cx('absolute box-content overflow-hidden rounded-full border-solid border-[var(--dot-ring)]', GLYPH_FILL[g])} style={style}>
      <GlyphCut g={g} dot={dot} />
    </span>
  );
}

/**
 * The «left» corner glyph of a former member (ADR-0097 §4, docs/08 «Бывший участник»): a small
 * door-out disc at the presence dot's place, cut out of the avatar with the same ring technique.
 */
function FormerGlyph({ size, ring }: { size: number; ring: string | undefined }): ReactNode {
  const { dot, ring: border, offset } = presenceDotGeometry(size);
  const style = { width: dot, height: dot, right: offset, bottom: offset, borderWidth: border, '--dot-ring': ring ?? 'var(--color-side)' } as CSSProperties;
  return (
    <span
      data-former-glyph
      aria-hidden
      className="absolute box-content grid place-items-center overflow-hidden rounded-full border-solid border-[var(--dot-ring)] bg-faint text-white"
      style={style}
    >
      <LogOut style={{ width: dot * 0.65, height: dot * 0.65 }} strokeWidth={3} />
    </span>
  );
}

/** The glyph's cutout in the surface colour: the moon's bite, the DND bar, the offline hole. */
function GlyphCut({ g, dot }: { g: PresenceGlyph; dot: number }): ReactNode {
  const cut = 'absolute rounded-full bg-[var(--dot-ring)]';
  const centred = cx(cut, 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2');
  if (g === 'idle') return <span className={cut} style={{ width: dot * 0.75, height: dot * 0.75, left: -dot * 0.125, top: -dot * 0.125 }} />;
  if (g === 'dnd') return <span className={centred} style={{ width: Math.round(dot * 0.625), height: Math.max(2, Math.round(dot * 0.25)) }} />;
  if (g === 'offline') return <span className={centred} style={{ width: dot / 2, height: dot / 2 }} />;
  return null;
}

/** The same glyph inline (status menu rows): `ring` is the surface it sits on. */
export function StatusGlyph({ status, size = 10, ring }: { status: PresenceStatus; size?: number; ring: string }): ReactNode {
  const g = presenceGlyph(status);
  return (
    <span
      data-presence={g}
      aria-hidden
      className={cx('relative inline-block shrink-0 overflow-hidden rounded-full', GLYPH_FILL[g])}
      style={{ width: size, height: size, '--dot-ring': ring } as CSSProperties}
    >
      <GlyphCut g={g} dot={size} />
    </span>
  );
}

/**
 * Round avatar (image or initial on an identity colour), optional presence dot and speaking
 * ring. The ring (docs/09 #15/#30): 2 px green outline with a 2 px gap, fades in over 100 ms
 * (`.speak-ring` in styles.css; no motion with prefers-reduced-motion). Pass `speaking` from
 * useVoice().speaking — it is already debounced (on at once, 300 ms hold off).
 *
 * `ringInside`: both rings drawn inside the avatar's own box (Discord's voice list, 24 px rows):
 * a 2 px inset ring with a 1 px gap, so nothing sticks out of a dense row.
 *
 * `connecting`: the «подключается» ring of a voice participant pending for more than 3 s
 * (stores/voicePending): a thin muted→accent arc turning around the avatar (`.connect-ring`;
 * static with prefers-reduced-motion). It replaces the speaking ring while shown.
 */
export function Avatar({
  userId,
  name,
  fileId,
  size = 32,
  presence,
  status,
  ring,
  speaking,
  connecting,
  ringInside = false,
  former = false,
  className,
}: {
  userId: string;
  name: string;
  fileId?: string;
  size?: number;
  /** Show the presence dot from the store (the user's aggregate status). */
  presence?: boolean;
  /** Show the dot with this status instead (the self panel: my chosen status). */
  status?: PresenceStatus;
  /** Surface colour around the dot (the cutout), e.g. `var(--color-popover-solid)`; default the sidebar. */
  ring?: string;
  speaking?: boolean;
  connecting?: boolean;
  ringInside?: boolean;
  /** A former member (ADR-0097): grey picture and the «left» glyph instead of any presence dot. */
  former?: boolean;
  className?: string;
}): ReactNode {
  if (connecting) speaking = false;
  // Outset ring: on the picture itself (outline). Inset ring: an overlay above it (an inset
  // box-shadow on an <img> would be painted under the picture).
  const outsetSpeaking = !ringInside && speaking ? 'true' : undefined;
  const stored = useWorkspaces((s) => (presence && status === undefined ? s.presences[userId]?.status : undefined));
  return (
    <span className={cx('relative inline-block shrink-0', className)} data-former={former ? 'true' : undefined} style={{ width: size, height: size }}>
      {fileId ? (
        <MediaImg
          path={thumbnailPath(fileId)}
          alt=""
          draggable={false}
          data-speaking={outsetSpeaking}
          className={cx(!ringInside && 'speak-ring', 'size-full rounded-full object-cover', former && 'grayscale')}
        />
      ) : (
        <span
          data-speaking={outsetSpeaking}
          className={cx(!ringInside && 'speak-ring', 'grid size-full place-items-center rounded-full font-semibold text-white', former && 'grayscale')}
          style={{ background: avatarColor(userId), fontSize: Math.round(size * 0.42) }}
        >
          {(name.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}
      {former ? <FormerGlyph size={size} ring={ring} /> : null}
      {!former && (presence || status !== undefined) ? <PresenceDot status={status ?? stored} size={size} ring={ring} /> : null}
      {ringInside && !connecting ? <span data-speaking={speaking ? 'true' : undefined} className="speak-ring-inset" aria-hidden /> : null}
      {connecting ? <span className={cx('connect-ring', ringInside && 'connect-ring-inset')} data-testid="connect-ring" aria-hidden /> : null}
    </span>
  );
}
