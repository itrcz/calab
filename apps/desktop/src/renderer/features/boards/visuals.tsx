import { BoardStatusType, TaskPriority, resolveStatusIcon, type StatusIconToken } from '@calaba/protocol';
import { AlertTriangle, Archive, Bug, Eye, Flag, Hourglass, Inbox, Lock, Minus, Pause, Rocket, ShieldCheck, Star, Zap, type LucideIcon } from 'lucide-react';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { dateTimeFormat } from '../../lib/format';

/**
 * Board visuals (docs/08 «Доски», as in Linear): the status glyph by type in the status colour,
 * the priority bars, colours of statuses and labels (0xRRGGBB data), due-date text.
 */
export function colorCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** The palette offered for statuses and labels (system colours, readable in both themes). */
export const PALETTE: readonly number[] = [0x8e8e93, 0xaeaeb2, 0xff453a, 0xff9f0a, 0xffcc00, 0x30d158, 0x64d2ff, 0x0a84ff, 0x5e5ce6, 0xbf5af2, 0xff375f, 0xac8e68];

const PALETTE_NAME: Readonly<Record<number, MessageKey>> = {
  0x8e8e93: 'boards.colorName.gray',
  0xaeaeb2: 'boards.colorName.silver',
  0xff453a: 'boards.colorName.red',
  0xff9f0a: 'boards.colorName.orange',
  0xffcc00: 'boards.colorName.yellow',
  0x30d158: 'boards.colorName.green',
  0x64d2ff: 'boards.colorName.teal',
  0x0a84ff: 'boards.colorName.blue',
  0x5e5ce6: 'boards.colorName.indigo',
  0xbf5af2: 'boards.colorName.purple',
  0xff375f: 'boards.colorName.pink',
  0xac8e68: 'boards.colorName.brown',
};

/** The spoken name of a palette colour (aria-label); a colour off the palette — its hex. */
export function colorName(color: number): string {
  const k = PALETTE_NAME[color & 0xffffff];
  return k ? t(k) : colorCss(color);
}

export const STATUS_TYPES: readonly BoardStatusType[] = [
  BoardStatusType.BACKLOG,
  BoardStatusType.UNSTARTED,
  BoardStatusType.STARTED,
  BoardStatusType.COMPLETED,
  BoardStatusType.CANCELLED,
];

export const STATUS_TYPE_LABEL: Record<number, MessageKey> = {
  [BoardStatusType.BACKLOG]: 'boards.type.backlog',
  [BoardStatusType.UNSTARTED]: 'boards.type.unstarted',
  [BoardStatusType.STARTED]: 'boards.type.started',
  [BoardStatusType.COMPLETED]: 'boards.type.completed',
  [BoardStatusType.CANCELLED]: 'boards.type.cancelled',
};

/** Tokens of TaskField.STATUS_TYPE values. */
export const STATUS_TYPE_TOKEN: Record<number, string> = {
  [BoardStatusType.BACKLOG]: 'backlog',
  [BoardStatusType.UNSTARTED]: 'unstarted',
  [BoardStatusType.STARTED]: 'started',
  [BoardStatusType.COMPLETED]: 'completed',
  [BoardStatusType.CANCELLED]: 'cancelled',
};

/** The share of the disc filled by a progress pie token (ADR-0093); others are not pies. */
export const PIE_SHARE: Readonly<Partial<Record<StatusIconToken, number>>> = { quarter: 0.25, half: 0.5, 'three-quarters': 0.75 };

/**
 * A pie of `share` (0..1) of a disc of radius `r` centred in the 14 px box, from 12 o'clock
 * clockwise: '' for none, two half arcs for the whole disc (one arc cannot close a circle).
 */
export function piePath(share: number, r = 3.5): string {
  const f = Math.min(1, Math.max(0, share));
  if (f === 0) return '';
  if (f === 1) return `M7 ${7 - r} A${r} ${r} 0 1 1 7 ${7 + r} A${r} ${r} 0 1 1 7 ${7 - r} Z`;
  const a = f * 2 * Math.PI;
  const x = +(7 + r * Math.sin(a)).toFixed(3);
  const y = +(7 - r * Math.cos(a)).toFixed(3);
  return `M7 7 L7 ${7 - r} A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y} Z`;
}

/** The lucide glyphs of the non-progress tokens. */
const LUCIDE: Readonly<Partial<Record<StatusIconToken, LucideIcon>>> = {
  eye: Eye,
  'shield-check': ShieldCheck,
  hourglass: Hourglass,
  pause: Pause,
  flag: Flag,
  star: Star,
  bolt: Zap,
  rocket: Rocket,
  bug: Bug,
  inbox: Inbox,
  archive: Archive,
  lock: Lock,
};

/**
 * The status glyph (14 px) by its icon token (ADR-0093; an empty / unknown token — by type):
 * the progress family is drawn here — dashed ring, ring, ring with a quarter / half / three
 * quarters pie, filled disc with a check / cross; the rest are lucide glyphs in the status colour.
 */
export const StatusIcon = memo(function StatusIcon({
  type,
  color,
  icon,
  size = 14,
  className,
}: {
  type: BoardStatusType;
  color: number;
  /** BoardStatus.icon; omitted or '' = the icon of the type. */
  icon?: string | undefined;
  size?: number;
  className?: string | undefined;
}): ReactNode {
  const c = colorCss(color);
  const token = resolveStatusIcon(icon, type);
  const Glyph = LUCIDE[token];
  if (Glyph) return <Glyph aria-hidden className={cx('shrink-0', className)} style={{ width: size, height: size, color: c }} strokeWidth={2} data-status-icon={token} />;
  const style: CSSProperties = { width: size, height: size };
  const common = { viewBox: '0 0 14 14', 'aria-hidden': true, className: cx('shrink-0', className), style, 'data-status-icon': token } as const;
  switch (token) {
    case 'dashed':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2.2 1.6" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6.25" fill={c} />
          <path d="M4.3 7.2 6.2 9 9.8 5.2" fill="none" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6.25" fill={c} />
          <path d="M5 5 9 9M9 5 5 9" fill="none" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default: {
      const pie = piePath(PIE_SHARE[token] ?? 0);
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
          {pie ? <path d={pie} fill={c} /> : null}
        </svg>
      );
    }
  }
});

export const PRIORITIES: readonly TaskPriority[] = [TaskPriority.NONE, TaskPriority.URGENT, TaskPriority.HIGH, TaskPriority.MEDIUM, TaskPriority.LOW];

export const PRIORITY_LABEL: Record<number, MessageKey> = {
  [TaskPriority.NONE]: 'boards.prio.none',
  [TaskPriority.LOW]: 'boards.prio.low',
  [TaskPriority.MEDIUM]: 'boards.prio.medium',
  [TaskPriority.HIGH]: 'boards.prio.high',
  [TaskPriority.URGENT]: 'boards.prio.urgent',
};

/** Priority: «—» none, urgent — an orange warning square, else 1–3 filled bars of three. */
export const PriorityIcon = memo(function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }): ReactNode {
  if (priority === TaskPriority.NONE) return <Minus className={cx('size-3.5 shrink-0 text-faint', className)} aria-hidden />;
  if (priority === TaskPriority.URGENT) return <AlertTriangle className={cx('size-3.5 shrink-0 text-[var(--color-red)]', className)} strokeWidth={2} aria-hidden />;
  const on = priority === TaskPriority.HIGH ? 3 : priority === TaskPriority.MEDIUM ? 2 : 1;
  return (
    <svg viewBox="0 0 14 14" className={cx('size-3.5 shrink-0 text-muted', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.5" height={3 + i * 3} rx="0.8" fill="currentColor" opacity={i < on ? 1 : 0.3} />
      ))}
    </svg>
  );
});

/** «15 янв.» (this year) / «15 янв. 2027 г.». */
export function formatDue(day: string, today: string): string {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return dateTimeFormat({ day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(date);
}

/** Overdue: a due date before today on a task not done. */
export const isOverdue = (due: string, today: string, done: boolean): boolean => !!due && !done && due < today;

/** A label chip dot. */
export function Dot({ color, size = 8 }: { color: number; size?: number }): ReactNode {
  return <span className="shrink-0 rounded-full" style={{ width: size, height: size, background: colorCss(color) }} aria-hidden />;
}
