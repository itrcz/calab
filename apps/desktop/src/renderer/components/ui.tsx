import * as DialogP from '@radix-ui/react-dialog';
import * as SliderP from '@radix-ui/react-slider';
import * as SwitchP from '@radix-ui/react-switch';
import * as TooltipP from '@radix-ui/react-tooltip';
import { ChevronDown, ChevronUp, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { cloneElement, forwardRef, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type FocusEvent as ReactFocusEvent, type InputHTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject, type SelectHTMLAttributes } from 'react';
import { flushSync } from 'react-dom';
import { extendTailwindMerge } from 'tailwind-merge';
import { t } from '../i18n';
import { autoFocusAllowed } from '../lib/phone';
import { mirrorTip } from '../services/webAppTip';
import { useWebApps } from '../stores/webApps';

/*
 * UI primitives (docs/08-design.md): macOS-like controls on design tokens only.
 * Controls are 28 px high and pill-shaped (--radius-control); icon-only buttons 8, list rows 6;
 * cards 8; panels/dialogs 12; 4 px spacing grid.
 */

/**
 * Class names with Tailwind conflict resolution: a caller's `className` wins over the
 * component's defaults (e.g. `w-36` over the Select's `w-full`) regardless of CSS order.
 */
const twMerge = extendTailwindMerge({
  // Our type scale (app/styles.css, docs/09 #17): `text-body` is a font size, not a colour —
  // without this `cx('text-body', 'text-fg')` would drop one of them.
  extend: { theme: { text: ['micro', 'caption', 'control', 'body', 'list', 'headline', 'title', 'large'] } },
});

export function cx(...c: Array<string | false | null | undefined>): string {
  return twMerge(c.filter(Boolean).join(' '));
}

/** Platform modifier label for shortcuts (⌘ on macOS, Ctrl elsewhere). */
export const MOD = typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost' | 'attention';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-strong text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'bg-hover text-fg hover:bg-[var(--color-fill-hover)] active:brightness-95',
  // HIG: destructive actions are red *text* on a neutral control.
  // macOS: destructive = red text (docs/08); a faint red tint keeps the text ≥ 4.5:1 on any surface.
  destructive: 'bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger-text hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] active:brightness-95',
  ghost: 'bg-transparent text-muted hover:bg-hover hover:text-fg',
  // An invitation to set something up (docs/08 «Цвета»: orange, e.g. «Подключить свой календарь»).
  attention: 'bg-attention text-attention-fg hover:brightness-110 active:brightness-95',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: 'sm' | 'md' | 'lg' }
>(function Button({ variant = 'primary', busy, size = 'md', className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-[filter,background-color] duration-[var(--motion-fast)] disabled:cursor-default disabled:opacity-40',
        // Phone layout (ADR-0021): 40 px touch targets, same pill shape.
        size === 'sm'
          ? 'h-6 px-2 text-caption mobile:h-8 mobile:px-3'
          : size === 'lg'
            ? 'h-8 px-4 text-body mobile:h-11 mobile:px-5 mobile:text-[15px]'
            : 'h-7 px-3 text-body mobile:h-10 mobile:px-4 mobile:text-[15px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean; danger?: boolean; tip?: boolean; size?: 'sm' | 'md' }
>(function IconButton({ label, shortcut, active, danger, tip = true, size = 'md', className, children, ...rest }, ref) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'inline-grid shrink-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-8',
        danger ? 'text-danger hover:bg-hover' : active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tip ? <Tip label={label} shortcut={shortcut}>{btn}</Tip> : btn;
});

/**
 * The «×» of a dialog, sheet, panel or card (docs/08 «Модалки — кнопка закрытия», docs/09 #105):
 * one component so every close box is hit the same way — above its neighbours (`relative z-10`),
 * a hit area ≥ 32 px even at 28 px (`before:` inset), the glyph transparent to the pointer.
 * `label` defaults to «Закрыть»; works under `DialogP.Close asChild` (forwards ref and props).
 */
export const CloseButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label?: string; shortcut?: string; tip?: boolean; size?: 'sm' | 'md'; iconClassName?: string }
>(function CloseButton({ label, shortcut = 'Esc', size = 'sm', className, iconClassName, ...rest }, ref) {
  return (
    <IconButton ref={ref} label={label ?? t('common.close')} shortcut={shortcut} size={size} className={cx(CLOSE_HIT, className)} {...rest}>
      <X className={cx(size === 'sm' ? 'size-4' : 'size-5', iconClassName)} strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
});

/** The close box's hit area (exported for the few that keep their own markup). */
export const CLOSE_HIT = "relative z-10 before:absolute before:-inset-1 before:content-[''] [&>svg]:pointer-events-none";

type TipProps = {
  label: ReactNode;
  shortcut?: string | undefined;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
};

/** How a lazy Tip woke up: what to replay on the freshly mounted Radix trigger. */
type TipWake = { focused: boolean; move: { x: number; y: number; pointerId: number; pointerType: string } | null };

// A pointer is pressed somewhere: a focus that comes with a press (a click) must not wake a Tip —
// waking remounts the element mid-press, the press would end on another node and the click be
// lost (Radix doesn't open a tooltip on a pointer-initiated focus either).
let pressed = false;
let pressTracked = false;
function trackPress(): void {
  if (pressTracked || typeof document === 'undefined') return;
  pressTracked = true;
  const up = (): void => {
    pressed = false;
  };
  document.addEventListener('pointerdown', () => (pressed = true), true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
}

type TipTriggerProps = {
  onPointerMove?: (e: ReactPointerEvent<HTMLElement>) => void;
  onFocus?: (e: ReactFocusEvent<HTMLElement>) => void;
};

/**
 * Tooltip. Lazy (docs/18 step 6): until the first mouse move over the element or a keyboard /
 * programmatic focus the child renders bare — a mounted Radix Tooltip costs ~9 component renders
 * on every parent render, ≈ 40 % of all renders in the feed. On wake the Radix tooltip mounts once
 * (the child is remounted under its trigger) and the waking event is replayed to it, so it opens
 * as an always-mounted one would: after the delay on hover, at once on keyboard focus (with
 * aria-describedby). Touch never wakes it (Radix ignores touch hover too).
 */
export function Tip(props: TipProps): ReactNode {
  const [wake, setWake] = useState<TipWake | null>(null);
  const child = props.children;
  if (wake || !isValidElement<TipTriggerProps>(child)) return <LiveTip {...props} wake={wake} />;
  trackPress();
  const own = child.props;
  return cloneElement(child, {
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      own.onPointerMove?.(e);
      if (e.pointerType === 'touch' || e.buttons !== 0) return;
      const w: TipWake = { focused: document.activeElement === e.currentTarget, move: { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType } };
      // Waking remounts the element, so it must be committed before the next input event: a
      // pointermove render is scheduled (not synchronous), and a press that follows at once (fast
      // pointer, a busy main thread in a call, Playwright's move→down) would go down on the old
      // node and up on the new one — no click (0.7.0: camera / «Отключиться» in the voice panel).
      flushSync(() => setWake(w));
    },
    onFocus: (e: ReactFocusEvent<HTMLElement>) => {
      own.onFocus?.(e);
      if (!pressed && e.target === e.currentTarget) setWake({ focused: true, move: null });
    },
  });
}

function LiveTip({ label, shortcut, children, side = 'top', wake }: TipProps & { wake: TipWake | null }): ReactNode {
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // A workspace app is open: the pointer leaving the trigger usually lands on a native view (the
  // site, or the tooltip's own overlay above it) that sends the page no pointer events, so a
  // hoverable tooltip would wait for them and stay open — close on leave instead.
  const appOpen = useWebApps((s) => s.open !== null);
  const woke = useRef(wake);
  useLayoutEffect(() => {
    const el = trigger.current;
    const w = woke.current;
    if (!w || !el) return;
    // The focused element was replaced: focus its successor (Radix opens on focus, as before).
    if (w.focused && document.activeElement !== el) el.focus({ preventScroll: true });
    const m = w.move;
    if (!m) return;
    const r = el.getBoundingClientRect();
    if (m.x < r.left || m.x > r.right || m.y < r.top || m.y > r.bottom) return;
    // Radix starts its open delay on pointermove: hand it the move that woke us.
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true, clientX: m.x, clientY: m.y, pointerId: m.pointerId, pointerType: m.pointerType, isPrimary: true }));
  }, []);
  return (
    <TooltipP.Root delayDuration={400} disableHoverableContent={appOpen}>
      <TooltipP.Trigger asChild ref={trigger}>
        {children}
      </TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content
          ref={content}
          data-app-tooltip
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="tip mat-popover anim-in z-[var(--z-tooltip)] flex max-w-72 items-center gap-2 rounded-[var(--radius-row)] px-2 py-1 text-caption text-fg"
        >
          {label}
          {shortcut ? (
            <kbd data-tip-shortcut className="font-sans text-micro text-faint">
              {shortcut}
            </kbd>
          ) : null}
          <TipOverApp content={content} />
        </TooltipP.Content>
      </TooltipP.Portal>
    </TooltipP.Root>
  );
}

/**
 * Mounted with an open tooltip's content: over an open workspace app on the desktop the tooltip
 * is drawn by a native overlay above the site (services/webAppTip.ts, ADR-0053 «Поправка 1»).
 * Renders nothing; a passive effect, so the content's ref is attached by then.
 */
function TipOverApp({ content }: { content: RefObject<HTMLDivElement | null> }): null {
  useEffect(() => {
    const el = content.current;
    return el ? mirrorTip(el) : undefined;
  }, [content]);
  return null;
}

/**
 * Text field. `icon` (16 px glyph: search, #, mail…) is drawn inside at the start and the text keeps
 * clear of it at every size — the phone's wider padding (mobile:px-3) included, which a caller's
 * plain `pl-7` would lose to (issue #10).
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(function Input(
  { className, autoFocus, icon, ...rest },
  ref,
) {
  const field = (
    <input
      ref={ref}
      // Phones: a field is focused only by a tap (iOS would scroll to it and raise the keyboard).
      autoFocus={autoFocus && autoFocusAllowed()}
      className={cx(
        'selectable h-7 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev px-2 mobile:h-10 mobile:px-3 text-body text-fg shadow-[var(--shadow-card)] placeholder:text-faint disabled:opacity-50',
        icon ? 'pl-7 mobile:pl-9' : null,
        className,
      )}
      {...rest}
    />
  );
  if (!icon) return field;
  return (
    <span className="relative flex w-full min-w-0 items-center">
      <span className="pointer-events-none absolute left-2 grid w-4 place-items-center text-muted mobile:left-3" aria-hidden>
        {icon}
      </span>
      {field}
    </span>
  );
});

/** What the password field's eye shows: the input type and the button's label / pressed state. */
export function passwordToggle(visible: boolean): { type: 'text' | 'password'; label: string; pressed: boolean } {
  return { type: visible ? 'text' : 'password', label: t(visible ? 'auth.hidePassword' : 'auth.showPassword'), pressed: visible };
}

/**
 * Password field with a «show password» eye (docs/09 #75): a 28×28 button inside the field at the
 * end (40×40 on phones) switches `type` between password and text. The input stays first in the
 * `Field` label (it is the labelled control) and keeps `autoComplete`/`name`, so password managers
 * and Enter-to-submit work as before; the button is `type="button"` and does not take the focus
 * from the field on a click. `visible`/`onVisibleChange` make it controlled (tests).
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { visible?: boolean; onVisibleChange?: (v: boolean) => void }
>(function PasswordInput({ className, visible: controlled, onVisibleChange, ...rest }, ref) {
  const [own, setOwn] = useState(false);
  const visible = controlled ?? own;
  const toggle = passwordToggle(visible);
  return (
    <span className="relative flex w-full min-w-0 items-center">
      <Input ref={ref} {...rest} type={toggle.type} className={cx('pr-7 mobile:pr-10', className)} />
      <button
        type="button"
        aria-label={toggle.label}
        aria-pressed={toggle.pressed}
        title={toggle.label}
        data-testid="password-toggle"
        disabled={rest.disabled}
        className="absolute right-0 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-[var(--radius-control)] text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg disabled:opacity-40 mobile:size-10"
        // Keep the caret in the field on a click; Tab still reaches the button.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOwn(!visible);
          onVisibleChange?.(!visible);
        }}
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </span>
  );
});

/** `ref` is a plain prop in React 19 (focus a select on open, e.g. a sheet's initialFocus). */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }): ReactNode {
  return (
    <select
      className={cx(
        // macOS pop-up button: no native chevron; our own ↕ chevron (10 px) sits 8 px from the right edge,
        // the text keeps clear of it (pr-7) and long values end with an ellipsis.
        'h-7 w-full min-w-0 appearance-none truncate rounded-[var(--radius-control)] border border-line bg-elev pl-2 pr-7 text-body text-fg shadow-[var(--shadow-card)] hover:bg-[color:var(--color-control-hover)] disabled:opacity-50 disabled:hover:bg-elev',
        'select-chevron',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** Stacked field (forms in dialogs): label above the control. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null | undefined; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-caption text-danger-text" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-caption text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

/** macOS toggle. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean | undefined }): ReactNode {
  return (
    <SwitchP.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full bg-[var(--color-fill-hover)] transition-colors duration-[var(--motion-fast)] data-[state=checked]:bg-accent disabled:opacity-40"
    >
      <SwitchP.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/30%)] transition-transform duration-[var(--motion-fast)] data-[state=checked]:translate-x-[18px]" />
    </SwitchP.Root>
  );
}

/** Row with a toggle (used in dialogs). */
export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <div className={cx('flex items-start justify-between gap-4 py-1', disabled && 'opacity-50')} data-settings-row>
      <span className="flex min-w-0 flex-col">
        <span className="text-body" data-settings-label data-settings-hint={typeof hint === 'string' ? hint : undefined}>
          {label}
        </span>
        {hint ? <span className="text-caption text-faint">{hint}</span> : null}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/** macOS segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[var(--radius-control)] bg-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            // nowrap: «Push-to-talk» must never break at its hyphen. Selected = a raised, lighter
            // segment (macOS), in dark too — not a darker «pressed» one. Focus ring at offset 0: it
            // fills the track's 2 px padding instead of spilling onto the neighbours.
            'h-6 whitespace-nowrap rounded-full px-3 text-control font-medium transition-colors duration-[var(--motion-fast)] focus-visible:outline-offset-0',
            value === o.value ? 'bg-[var(--color-segment-on)] text-fg shadow-[var(--shadow-segment)]' : 'text-fg hover:bg-[var(--color-fill)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * `pointerOnly`: the slider is a mouse affordance inside a control that owns the keyboard and the
 * accessible name (e.g. a menu item adjusted with ←/→): hidden from AT and not focusable.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  pointerOnly = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  pointerOnly?: boolean;
}): ReactNode {
  return (
    <SliderP.Root
      className="relative flex h-5 w-full touch-none select-none items-center"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0] ?? value)}
      aria-label={pointerOnly ? undefined : label}
      aria-hidden={pointerOnly || undefined}
      // Radix renders aria-disabled="false" on the root span; drop it (a stray ARIA node).
      aria-disabled={undefined}
    >
      <SliderP.Track className="relative h-1 grow rounded-full bg-[var(--color-fill-hover)]">
        <SliderP.Range className="absolute h-full rounded-full bg-accent" />
      </SliderP.Track>
      <SliderP.Thumb aria-label={pointerOnly ? undefined : label} tabIndex={pointerOnly ? -1 : undefined} className="block size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/35%)]" />
    </SliderP.Root>
  );
}

// ---------------------------------------------------------------- System-Settings-style groups

/** Rounded card grouping settings rows (System Settings). */
export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5 rounded-[var(--radius-card)]" data-settings-row>
      {title ? (
        <h3 className="px-1 text-caption font-semibold text-muted" data-settings-label>
          {title}
        </h3>
      ) : null}
      <div className="divide-y divide-[var(--color-card-line)] overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">{children}</div>
      {footer ? <p className="px-1 text-caption text-faint">{footer}</p> : null}
    </section>
  );
}

/**
 * Settings row: title (and hint) left, control right. `data-settings-*` make it findable by the
 * settings search (components/SettingsWindow.tsx).
 */
export function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children?: ReactNode; htmlFor?: string }): ReactNode {
  const id = useId();
  const searchHint = typeof hint === 'string' ? hint : undefined;
  return (
    // Phone layout: the control wraps under a long label instead of squeezing it (ADR-0021).
    <div className="flex min-h-10 items-center justify-between gap-4 px-3 py-2 mobile:flex-wrap mobile:gap-x-3 mobile:gap-y-2" data-settings-row>
      <div className="flex min-w-0 flex-col" id={id}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-body" data-settings-label data-settings-hint={searchHint}>
            {label}
          </label>
        ) : (
          <span className="text-body" data-settings-label data-settings-hint={searchHint}>
            {label}
          </span>
        )}
        {hint ? <span className="text-caption text-faint">{hint}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 mobile:max-w-full mobile:shrink">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

/**
 * Marks a scroll box with `data-scroll-top` / `data-scroll-bottom` while content is hidden past
 * that edge (a dialog body, docs/09 #147). Attributes on the node — the dialog never re-renders
 * on scroll; a field opening inside is caught by the ResizeObserver on the content.
 */
function trackScrollEdges(el: HTMLDivElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const update = (): void => {
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    if (top !== el.hasAttribute('data-scroll-top')) el.toggleAttribute('data-scroll-top', top);
    if (bottom !== el.hasAttribute('data-scroll-bottom')) el.toggleAttribute('data-scroll-bottom', bottom);
  };
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  ro?.observe(el);
  for (const child of Array.from(el.children)) ro?.observe(child);
  el.addEventListener('scroll', update, { passive: true });
  update();
  return () => {
    ro?.disconnect();
    el.removeEventListener('scroll', update);
  };
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
  medium,
  footer,
  closeButton = true,
  initialFocus,
  fill = false,
  nonModal = false,
  keepOpen,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
  wide?: boolean;
  /** A 560 px sheet (the rule editor, ADR-0060 §6). */
  medium?: boolean;
  footer?: ReactNode;
  /** macOS alerts have no close box (confirmations): only «Отмена» and the action. */
  closeButton?: boolean;
  /** Field focused on open (Radix would focus the close box first — and show its tooltip). */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * A list dialog (docs/09 #52): the body is a flex column, so a child with `flex-1 min-h-0`
   * (PickerPanel with `fill`) takes the height left under the header, down to the bottom
   * padding — it scrolls inside instead of the body, and the dialog is never taller than the
   * window. Without it the body scrolls as a whole.
   */
  fill?: boolean;
  /**
   * No scrim, the rest of the window stays usable (the meeting dialog: members and voice rooms are
   * dragged into it, owner 29.09). A click outside still closes it through `onClose`, except on
   * what `keepOpen` accepts (a drag source, another dialog).
   */
  nonModal?: boolean;
  keepOpen?: (target: Element) => boolean;
}): ReactNode {
  return (
    <DialogP.Root open={open} onOpenChange={(o) => !o && onClose()} modal={!nonModal}>
      <DialogP.Portal>
        {nonModal ? null : <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />}
        <DialogP.Content aria-modal={nonModal ? undefined : 'true'}
          onInteractOutside={(e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (target && keepOpen?.(target)) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => {
            // Phones: the sheet itself takes the focus — no field focused (and no keyboard) until a tap.
            if (!autoFocusAllowed()) {
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.focus();
              return;
            }
            if (!initialFocus?.current) return;
            e.preventDefault();
            initialFocus.current.focus();
          }}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[calc(100vh-92px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-panel)] text-body focus:outline-none',
            wide ? 'max-w-[880px]' : medium ? 'max-w-[560px]' : 'max-w-[440px]',
            nonModal && 'no-drag shadow-[var(--shadow-popover)]',
            // Phone layout (ADR-0021): a bottom sheet — full width, from the bottom edge, above the home indicator.
            'mobile:anim-sheet mobile:inset-x-0 mobile:bottom-[var(--kb-inset)] mobile:top-auto mobile:max-h-[calc(var(--app-height)-var(--safe-top)-16px)] mobile:w-full mobile:max-w-none mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-b-none mobile:rounded-t-[16px] mobile:border-b-0 mobile:pb-[var(--safe-bottom)]',
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5">
            {/* A flex sibling, never under the «×»: the title wraps before it (docs/09 #105). */}
            <div className="min-w-0 flex-1">
              <DialogP.Title className="text-headline font-semibold">{title}</DialogP.Title>
              {description ? (
                <DialogP.Description className="mt-1 text-body text-muted">{description}</DialogP.Description>
              ) : (
                <DialogP.Description className="sr-only">{title}</DialogP.Description>
              )}
            </div>
            {closeButton ? (
              <CloseButton className="-mr-1 -mt-1" onClick={onClose} />
            ) : null}
          </div>
          {/* Only the body scrolls (the header and the buttons stay, docs/09 #147); a hairline at an
              edge with more content past it is the scroll cue — set on the node, no re-render; `-my-px`
              keeps the transparent borders out of the layout. */}
          <div
            ref={fill ? undefined : trackScrollEdges}
            className={cx(
              '-my-px min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-transparent px-5 pb-5 pt-4 transition-colors duration-[var(--motion-fast)] data-[scroll-bottom]:border-b-line data-[scroll-top]:border-t-line',
              fill && 'flex flex-col',
            )}
          >
            {children}
          </div>
          {/* macOS order: secondary/cancel on the left of the primary action, primary rightmost. */}
          {footer ? <div className="flex shrink-0 justify-end gap-2 px-5 pb-5">{footer}</div> : null}
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }): ReactNode {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label={label ?? t('common.loading')} role="status" />;
}

/** Empty state: short text + one action (docs/08, Layout). */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-body text-muted">
      <div>{children}</div>
      {action}
    </div>
  );
}

/**
 * Small label chip («Гость», «LIVE», role names): 11/600, sentence case, pill — one style
 * for every badge (UX review). `danger` = white on the red fill (LIVE), `accent` = white on
 * accent-strong, `neutral` = label on a fill.
 */
export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'danger'; className?: string; title?: string }): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-micro font-semibold leading-4',
        tone === 'danger' ? 'bg-danger-fill text-white' : tone === 'accent' ? 'bg-accent-strong text-accent-fg' : 'bg-hover text-fg',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Numeric field with a stepper (macOS NSStepper): 80 px, ↑/↓ keys and the − / + buttons change
 * the value by one; typing commits on blur / Enter; Esc restores.
 */
export function Stepper({
  value,
  min,
  max,
  onCommit,
  label,
  id,
  format,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  label: string;
  id?: string;
  /** Text for a value (e.g. 0 → «∞»); the field shows it while not focused. */
  format?: (v: number) => string;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const clamp = (n: number): number => Math.min(max, Math.max(min, n));
  const commit = (raw: string | null): void => {
    setDraft(null);
    if (raw === null) return;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const next = clamp(n);
    if (next !== value) onCommit(next);
  };
  const step = (d: number): void => {
    const next = clamp((draft !== null ? Number.parseInt(draft, 10) || 0 : value) + d);
    // While typing in the field keep showing the raw number; otherwise the formatted value.
    setDraft(document.activeElement === input.current ? String(next) : null);
    if (next !== value) onCommit(next);
  };
  return (
    <span className="inline-flex h-7 w-20 shrink-0 items-stretch overflow-hidden rounded-[var(--radius-control)] border border-line bg-elev shadow-[var(--shadow-card)] has-[:focus-visible]:border-focus" data-focus-box>
      <input
        ref={input}
        id={id}
        aria-label={label}
        inputMode="numeric"
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : undefined}
        className="selectable w-0 min-w-0 flex-1 bg-transparent px-2 text-right text-body tabular-nums text-fg outline-none"
        value={draft ?? (format ? format(value) : String(value))}
        onFocus={(e) => {
          setDraft(String(value));
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, String(max).length))}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            step(e.key === 'ArrowUp' ? 1 : -1);
          } else if (e.key === 'Escape' && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="flex w-5 flex-col border-l border-line">
        <button type="button" tabIndex={-1} aria-label={t('common.increase', { label })} title={t('common.more')} disabled={value >= max} onClick={() => step(1)} className="grid flex-1 place-items-center text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
          <ChevronUp className="size-3" aria-hidden />
        </button>
        <button type="button" tabIndex={-1} aria-label={t('common.decrease', { label })} title={t('common.less')} disabled={value <= min} onClick={() => step(-1)} className="grid flex-1 place-items-center border-t border-line text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </span>
    </span>
  );
}
