import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, Eraser, MousePointer2, Pencil } from 'lucide-react';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { IconButton, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n/types';
import { PaintLoop } from '../../lib/annot/loop';
import { ANNOT_COLORS, contentRect, css, toFrame, toFrameClamped, type Rect } from '../../lib/annot/paint';
import { annot } from '../../services/annot';
import { setAnnot, useAnnot, type AnnotTool } from '../../stores/annot';
import { useVoice, type RemoteStream } from '../../stores/voice';
import { menuBox } from '../shell/menu';

/**
 * Laser pointer and pen over a stream (ADR-0028, docs/08 «Аннотации»): a canvas over the <video>
 * (everyone's annotations, letterbox-aware) and the viewer's tool pill. The presenter's side is
 * the overlay window (main/annotOverlay.ts) and the switch in the voice panel (VoiceBar).
 */

/** Tools shown for this stream: someone else's, allowed by its presenter, and I may speak. */
export function useCanAnnotate(stream: RemoteStream | undefined): boolean {
  const canSpeak = useVoice((s) => s.canSpeak);
  const policy = useAnnot((s) => s.policy);
  return annot.canAnnotate(stream, canSpeak, policy);
}

function frameRect(canvas: HTMLCanvasElement, video: HTMLVideoElement | null): Rect {
  return contentRect(canvas.clientWidth, canvas.clientHeight, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
}

/**
 * The annotation canvas of one stream view. `interactive`: this view takes input while a tool is
 * on (stage, full screen, pop-out); the PiP only shows.
 */
export function AnnotLayer({ stream, video, win = window, interactive }: { stream: RemoteStream; video: RefObject<HTMLVideoElement | null>; win?: Window; interactive: boolean }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sid = stream.trackSid;
  const tool = useAnnot((s) => s.tool);
  const can = useCanAnnotate(stream);
  const active: AnnotTool = interactive && can ? tool : 'none';
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const loop = new PaintLoop(canvas, annot.scene(sid), () => frameRect(canvas, video.current), win);
    const off = annot.subscribe(sid, () => loop.kick());
    const ro = new ResizeObserver(() => loop.kick());
    ro.observe(canvas);
    loop.kick();
    return () => {
      off();
      ro.disconnect();
      loop.dispose();
    };
  }, [sid, video, win]);

  // A tool switched off mid-stroke: finish the stroke.
  useEffect(() => {
    if (active !== 'pen' && drawing.current) {
      drawing.current = false;
      annot.strokeEnd();
    }
  }, [active]);

  const at = (e: ReactPointerEvent<HTMLCanvasElement>, clamp: boolean): [number, number] | null => {
    const canvas = e.currentTarget;
    const box = canvas.getBoundingClientRect();
    const rect = frameRect(canvas, video.current);
    // The box may be scaled by the viewer's zoom (CSS transform): back to the canvas's own pixels.
    const x = ((e.clientX - box.left) * canvas.clientWidth) / (box.width || 1);
    const y = ((e.clientY - box.top) * canvas.clientHeight) / (box.height || 1);
    return clamp ? toFrameClamped(rect, x, y) : toFrame(rect, x, y);
  };

  return (
    <canvas
      ref={canvasRef}
      data-testid="annot-layer"
      data-tool={active}
      aria-hidden
      className={cx('absolute inset-0 size-full', active === 'none' ? 'pointer-events-none' : 'cursor-crosshair touch-none')}
      onPointerDown={(e) => {
        if (active === 'none' || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (active === 'pen') {
          const p = at(e, false);
          if (!p) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          annot.strokeStart(sid, p[0], p[1]);
        } else {
          const p = at(e, false);
          if (p) annot.pointer(sid, p[0], p[1]);
        }
      }}
      onPointerMove={(e) => {
        if (active === 'pen') {
          if (!drawing.current) return;
          const p = at(e, true);
          if (p) annot.strokeMove(p[0], p[1]);
        } else if (active === 'pointer') {
          // Mouse: follows the cursor; touch: while the finger is down.
          if (e.pointerType !== 'mouse' && e.buttons === 0) return;
          const p = at(e, false);
          if (p) annot.pointer(sid, p[0], p[1]);
        }
      }}
      onPointerUp={() => {
        if (!drawing.current) return;
        drawing.current = false;
        annot.strokeEnd();
      }}
      onPointerCancel={() => {
        if (!drawing.current) return;
        drawing.current = false;
        annot.strokeEnd();
      }}
    />
  );
}

const COLOR_NAMES: Record<number, MessageKey> = {
  0xff453a: 'annot.color.red',
  0xffd60a: 'annot.color.yellow',
  0x30d158: 'annot.color.green',
  0x0a84ff: 'annot.color.blue',
  0xbf5af2: 'annot.color.purple',
  0xffffff: 'annot.color.white',
};

// Like the stage's overlay buttons; a tool that is on keeps a light fill.
const pillBtn = 'text-white hover:bg-white/15 hover:text-white aria-pressed:bg-white/25';

function Swatch({ color, size = 14 }: { color: number; size?: number }): ReactNode {
  return <span aria-hidden className="block shrink-0 rounded-full ring-1 ring-white/60" style={{ width: size, height: size, background: css(color) }} />;
}

/**
 * The viewer's tools on a stream (stage and full screen): «Указка», «Карандаш», colour,
 * «Очистить». A vertical pill at the right edge of the video: clear of the streamer chip (top
 * left), «Показать чат» (top right) and the control bar (bottom). Desktop: shows on hover like the
 * control bar and stays while a tool is on; touch screens: always visible.
 */
export function AnnotTools({
  stream,
  win = window,
  visible,
}: {
  stream: RemoteStream;
  /** The window the tools live in (the pop-out is another one: its menu portals there). */
  win?: Window;
  /** Full screen: follows the overlay bar's idle hiding instead of hover. */
  visible?: boolean;
}): ReactNode {
  const can = useCanAnnotate(stream);
  const tool = useAnnot((s) => s.tool);
  const chosen = useAnnot((s) => s.color);
  if (!can) return null;
  const color = chosen ?? annot.myColor();
  const toggle = (next: AnnotTool): void => setAnnot({ tool: tool === next ? 'none' : next });
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t('annot.tools')}
      data-testid="annot-tools"
      className={cx(
        'absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-[var(--radius-card)] bg-black/70 p-0.5 ring-1 ring-white/10 transition-opacity duration-[var(--motion-fast)] focus-within:opacity-100',
        tool !== 'none' || visible === true
          ? 'opacity-100'
          : visible === false
            ? 'pointer-events-none opacity-0'
            : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
      )}
    >
      <IconButton size="sm" label={t('annot.pointer')} aria-pressed={tool === 'pointer'} className={pillBtn} onClick={() => toggle('pointer')}>
        <MousePointer2 className="size-4" aria-hidden />
      </IconButton>
      <IconButton size="sm" label={t('annot.pen')} aria-pressed={tool === 'pen'} className={pillBtn} onClick={() => toggle('pen')}>
        <Pencil className="size-4" aria-hidden />
      </IconButton>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" aria-label={t('annot.color')} title={t('annot.color')} className="grid size-7 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] hover:bg-white/15 data-[state=open]:bg-white/15">
            <Swatch color={color} />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal container={win.document.body}>
          <Dropdown.Content className={cx(menuBox, 'min-w-0')} side="left" align="center" sideOffset={8} aria-label={t('annot.color')}>
            <Dropdown.RadioGroup className="flex gap-1" value={String(color)} onValueChange={(v) => setAnnot({ color: Number(v) })}>
              {ANNOT_COLORS.map((c) => (
                <Dropdown.RadioItem
                  key={c}
                  value={String(c)}
                  aria-label={t(COLOR_NAMES[c] ?? 'annot.color')}
                  className="relative grid size-7 cursor-default place-items-center rounded-[var(--radius-icon)] outline-none data-[highlighted]:bg-hover"
                >
                  <Swatch color={c} size={18} />
                  <Dropdown.ItemIndicator className="absolute inset-0 grid place-items-center">
                    <Check className={cx('size-3', c === 0xffffff || c === 0xffd60a ? 'text-black' : 'text-white')} aria-hidden />
                  </Dropdown.ItemIndicator>
                </Dropdown.RadioItem>
              ))}
            </Dropdown.RadioGroup>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <span className="my-0.5 h-px w-4 bg-white/25" aria-hidden />
      <IconButton size="sm" label={t('annot.clear')} className={pillBtn} onClick={() => annot.clear(stream.trackSid)}>
        <Eraser className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}

/**
 * The presenter's switch in my stream's panel (VoiceBar): viewers may annotate my stream (sent
 * to them as POLICY), and «Стереть рисунки» — my clear erases everyone's strokes.
 */
export function MyStreamAnnot(): ReactNode {
  const allow = useAnnot((s) => s.allowMine);
  return (
    <span className="mt-1 flex items-center gap-2" data-testid="my-stream-annot">
      <Toggle checked={allow} onChange={(v) => annot.setAllowMine(v)} label={t('annot.allowViewers')} />
      <span className="min-w-0 flex-1 truncate text-muted" aria-hidden>
        {t('annot.allowViewers')}
      </span>
      {allow ? (
        <IconButton size="sm" label={t('annot.clearAll')} onClick={() => annot.clearMine()}>
          <Eraser className="size-4" aria-hidden />
        </IconButton>
      ) : null}
    </span>
  );
}
