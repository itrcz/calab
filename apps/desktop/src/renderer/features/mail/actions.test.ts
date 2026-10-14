import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmAction = vi.fn<(title: string, text: string, action: string) => Promise<boolean>>();
vi.mock('../../stores/toasts', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../components/Confirm', () => ({ confirmAction: (title: string, text: string, action: string) => confirmAction(title, text, action) }));

const { createMockMailApi } = await import('./mock/mockApi');
const { initMail, reduceEvent, resetMail, selectBox, trashBox, inTrash, useMail } = await import('../../stores/mail');
const { deleteKeysForever, emptyTrash } = await import('./actions');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('«Очистить корзину» / «Удалить навсегда» (ADR-0088 §7 folders.empty)', () => {
  beforeEach(async () => {
    confirmAction.mockReset();
    await initMail(createMockMailApi({ delayMs: 0, now: () => Date.UTC(2026, 9, 12, 9) }));
  });
  afterEach(() => resetMail());

  it('the trash box: confirm «Удалить N писем навсегда?», cancel keeps it, confirm empties it', async () => {
    const id = useMail.getState().accountIds[0] ?? '';
    selectBox({ scope: id, folder: 'trash' });
    await flush();
    const box = trashBox(useMail.getState());
    expect(box).not.toBeNull();
    expect(inTrash(useMail.getState())).toBe(true);
    const total = box?.total ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(useMail.getState().order.length).toBeGreaterThan(0);

    confirmAction.mockResolvedValueOnce(false);
    await emptyTrash(box?.id ?? '', total);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    const [title, text, action] = confirmAction.mock.calls[0] ?? [];
    expect(title).toBe('Очистить корзину');
    expect(text).toMatch(new RegExp(`^Удалить ${String(total)} (письмо|письма|писем) навсегда\\? Это нельзя отменить\\.$`));
    expect(action).toBe('Удалить навсегда');
    await flush();
    expect(trashBox(useMail.getState())?.total).toBe(total);

    confirmAction.mockResolvedValueOnce(true);
    await emptyTrash(box?.id ?? '', total);
    await flush();
    expect(trashBox(useMail.getState())?.total).toBe(0);
    expect(useMail.getState().order).toHaveLength(0);
  });

  it('an empty trash asks nothing; not the trash → no trash box', async () => {
    await emptyTrash('x', 0);
    expect(confirmAction).not.toHaveBeenCalled();
    const id = useMail.getState().accountIds[0] ?? '';
    selectBox({ scope: id, folder: 'inbox' });
    await flush();
    expect(trashBox(useMail.getState())).toBeNull();
    expect(inTrash(useMail.getState())).toBe(false);
  });

  it('«Удалить навсегда»: one row without a question, several rows confirmed', async () => {
    const id = useMail.getState().accountIds[0] ?? '';
    selectBox({ scope: id, folder: 'inbox' });
    await flush();
    const [a, b, c] = useMail.getState().order;
    if (!a || !b || !c) throw new Error('rows');
    await deleteKeysForever([a]);
    expect(confirmAction).not.toHaveBeenCalled();
    await flush();
    expect(useMail.getState().order).not.toContain(a);
    confirmAction.mockResolvedValueOnce(false);
    await deleteKeysForever([b, c]);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(useMail.getState().order).toEqual(expect.arrayContaining([b, c]));
    confirmAction.mockResolvedValueOnce(true);
    await deleteKeysForever([b, c]);
    await flush();
    expect(useMail.getState().order).not.toContain(b);
  });

  it('the mock refuses to empty other folders', async () => {
    const api = createMockMailApi({ delayMs: 0 });
    const [acc] = await api.accounts.list();
    await expect(api.folders.empty(`${acc?.id ?? ''}/inbox`)).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('engine: failed keeps the report for «Скопировать отчёт»; up clears it', () => {
    const s = useMail.getState();
    expect(reduceEvent(s, { type: 'engine', state: 'failed', report: 'exit code 1' })).toMatchObject({ engineDown: true, engineReport: 'exit code 1' });
    expect(reduceEvent(s, { type: 'engine', state: 'down' })).toMatchObject({ engineDown: true, engineReport: null });
    expect(reduceEvent(s, { type: 'engine', state: 'up' })).toMatchObject({ engineDown: false, engineReport: null });
  });
});
