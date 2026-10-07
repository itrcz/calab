/** macOS-style menus: popover material, 32 px items (owner 07.10), accent highlight (Radix dropdown/context menus). */
export const menuItem =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2.5 text-body text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-strong data-[highlighted]:text-accent-fg';
export const menuBox = 'mat-popover anim-in z-[var(--z-popover)] min-w-52 rounded-[var(--radius-card)] p-1';
export const menuSeparator = 'my-1 h-px bg-line';
export const menuLabel = 'px-2 pb-1 pt-1.5 text-micro font-semibold text-muted';
/** Popover panels (not menus): same material, roomier padding. */
export const popoverBox = 'mat-popover anim-in z-[var(--z-popover)] rounded-[var(--radius-panel)] text-body text-fg';
