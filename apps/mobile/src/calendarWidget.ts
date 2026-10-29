import type { CalendarWidgetAction } from '../../desktop/src/shared/calendarWidgetLink';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { CalendarWidgetOperation } from '../../desktop/src/shared/hostCalendarWidget';

interface NativeCalendarWidget {
  scheme(): string;
  isSupported(): boolean;
  bind(document: string, binding: string): Promise<boolean>;
  configure(document: string, token: string, expiresAt: string): Promise<boolean>;
  refresh(document: string): Promise<boolean>;
  clear(document: string): Promise<boolean>;
}
const native = Platform.OS === 'ios' ? requireOptionalNativeModule<NativeCalendarWidget>('CalabCalendarWidget') : null;
export const calendarWidgetScheme = native?.scheme() ?? '';
export const calendarWidgetEnabled = native?.isSupported() === true;
export async function calendarWidgetOperation(document: string, operation: CalendarWidgetOperation): Promise<boolean> {
  try {
    if (operation.operation === 'opened') return true;
    if (operation.operation === 'bind') return await native?.bind(document, operation.binding) === true;
    if (operation.operation === 'configure') return await native?.configure(document, operation.token, operation.expiresAt) === true;
    return await native?.[operation.operation](document) === true;
  } catch { return false; }
}
export function calendarWidgetReply(host: number, document: string, request: number, ok: boolean): string {
  return `window.dispatchEvent(new CustomEvent('calab-host-calendar-widget', {detail: ${JSON.stringify({ v: 1, host, document, request, ok })}})); true;`;
}

export function calendarWidgetOpen(host: number, document: string, action: CalendarWidgetAction, tap: number): string {
  return `window.dispatchEvent(new CustomEvent('calab-host-calendar-open', {detail: ${JSON.stringify({ v: 1, host, document, action, tap })}})); true;`;
}
