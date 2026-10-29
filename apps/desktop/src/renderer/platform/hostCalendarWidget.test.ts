import { expect, it, vi } from 'vitest';
import { createHostCapabilities } from './hostActivity';

it('calendar grant waits for handshake, ignores foreign replies and is cancelled on logout', async () => {
  const handlers = new Map<string, (event: CustomEvent<unknown>) => void>();
  const send = vi.fn();
  const bridge = { version: 1, calendarWidgetVersion: 1, host: 0, document: 'old', send, rotateDocument: () => { bridge.document = 'new'; } };
  const caps = createHostCapabilities({ CalabHostActivity: bridge, addEventListener: (name: string, fn: (e: CustomEvent<unknown>) => void) => handlers.set(name, fn) } as unknown as Window);
  expect(caps.calendarWidget).toBeDefined();
  if (!caps.calendarWidget) throw new Error('missing capability');
  const emit = (name: string, detail: object) => handlers.get(name)?.({ detail } as CustomEvent<unknown>);
  const result = caps.calendarWidget.configure('a.b.c', '2026-11-20T00:00:00Z');
  expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({ type: 'hello' });
  emit('calab-host-activity-ready', { v: 1, host: 0, document: 'old', capability: 'notifications', calendarWidget: 1 });
  expect(JSON.parse(String(send.mock.lastCall?.[0]))).toMatchObject({ type: 'calendarWidget', operation: 'configure' });
  const done = vi.fn(); void result.then(done);
  emit('calab-host-calendar-widget', { v: 1, host: 0, document: 'foreign', request: 1, ok: true });
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  caps.sessionActivity?.clear('logout');
  await expect(result).resolves.toBe(false);
  emit('calab-host-calendar-widget', { v: 1, host: 0, document: 'old', request: 1, ok: true });
  expect(done).toHaveBeenCalledExactlyOnceWith(false);
});

it('queues a cold widget tap until the app subscribes and fences warm taps to the current document', () => {
  const handlers = new Map<string, (event: CustomEvent<unknown>) => void>();
  const bridge = { version: 1, calendarWidgetVersion: 1, host: 0, document: 'old', send: vi.fn(), rotateDocument: () => { bridge.document = 'new'; } };
  const caps = createHostCapabilities({ CalabHostActivity: bridge, addEventListener: (name: string, fn: (e: CustomEvent<unknown>) => void) => handlers.set(name, fn) } as unknown as Window);
  const emit = (name: string, detail: object) => handlers.get(name)?.({ detail } as CustomEvent<unknown>);
  emit('calab-host-activity-ready', { v: 1, host: 0, document: 'old', capability: 'notifications', calendarWidget: 1 });
  const tap = { v: 1, host: 0, document: 'old', tap: 1, action: { kind: 'day', day: '2026-11-01' } };
  emit('calab-host-calendar-open', tap);
  if (!caps.calendarWidget?.onOpen) throw new Error('missing navigation');
  const open = vi.fn(); caps.calendarWidget.onOpen(open);
  expect(open).toHaveBeenCalledExactlyOnceWith(tap.action);
  emit('calab-host-calendar-open', { ...tap, document: 'foreign' });
  expect(open).toHaveBeenCalledTimes(1);
  emit('calab-host-calendar-open', { ...tap, tap: 2, action: { kind: 'create', day: '2026-11-01' } });
  expect(open).toHaveBeenCalledTimes(2);
});

it('keeps ordinary links and widget navigation independent under one revocable handshake', () => {
  const handlers = new Map<string, (event: CustomEvent<unknown>) => void>();
  const bridge = { version: 1, calendarWidgetVersion: 1, host: 0, document: 'old', send: vi.fn(), rotateDocument: () => { bridge.document = 'new'; } };
  const caps = createHostCapabilities({ CalabHostActivity: bridge, location: { origin: 'https://calab.example.com' }, addEventListener: (name: string, fn: (e: CustomEvent<unknown>) => void) => handlers.set(name, fn) } as unknown as Window);
  const emit = (name: string, detail: object) => handlers.get(name)?.({ detail } as CustomEvent<unknown>);
  const link = vi.fn(), widget = vi.fn();
  caps.onHostLink?.(link); caps.calendarWidget?.onOpen?.(widget);
  const ready = { v: 1, host: 0, document: 'old', capability: 'notifications', calendarWidget: 1, links: 1 };
  const action = { kind: 'day', day: '2026-11-01' };
  const tap = { v: 1, host: 0, document: 'old', tap: 1, action };
  const url = 'https://calab.example.com/t/INV-820';
  emit('calab-host-activity-ready', ready);
  emit('calab-host-calendar-open', tap);
  emit('calab-host-link', { v: 1, host: 0, document: 'old', url });
  expect(widget).toHaveBeenCalledExactlyOnceWith(action);
  expect(link).toHaveBeenCalledExactlyOnceWith(url);
  caps.sessionActivity?.clear('logout');
  emit('calab-host-calendar-open', { ...tap, tap: 2 });
  emit('calab-host-link', { v: 1, host: 0, document: 'old', url });
  expect(widget).toHaveBeenCalledTimes(1); expect(link).toHaveBeenCalledTimes(1);
  emit('calab-host-activity-ready', { ...ready, document: 'new', calendarWidget: 0 });
  emit('calab-host-calendar-open', { ...tap, document: 'new', tap: 3 });
  emit('calab-host-link', { v: 1, host: 0, document: 'new', url });
  expect(widget).toHaveBeenCalledTimes(1); expect(link).toHaveBeenCalledTimes(2);
});
