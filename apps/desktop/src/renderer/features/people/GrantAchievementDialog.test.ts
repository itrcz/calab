import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: {}, isWeb: false }));
vi.mock('../../lib/api/endpoints', () => ({ api: {} }));
vi.mock('../../lib/achievementCatalog', () => ({ useAchievementCatalog: () => [], invalidateMemberAchievements: () => undefined }));
vi.mock('./AchievementView', () => ({ openGrantInChat: () => undefined }));
import { GrantEmpty, GrantSubmit, canGrant } from './GrantAchievementDialog';

const submit = (enabled: boolean): string => renderToStaticMarkup(createElement(GrantSubmit, { enabled, busy: false, onClick: () => undefined }));

describe('grant dialog (ADR-0061 §5)', () => {
  it('«Вручить» is disabled without «за что»', () => {
    expect(canGrant('a1', '', false)).toBe(false);
    expect(canGrant('a1', '   ', false)).toBe(false);
    expect(submit(canGrant('a1', '', false))).toContain('disabled=""');
  });

  it('needs an achievement chosen and is off while sending', () => {
    expect(canGrant('', 'за релиз', false)).toBe(false);
    expect(canGrant('a1', 'за релиз', true)).toBe(false);
  });

  it('is enabled with an achievement and a note of 1..120 characters', () => {
    expect(canGrant('a1', 'за релиз', false)).toBe(true);
    expect(canGrant('a1', 'x'.repeat(121), false)).toBe(false);
    expect(submit(true)).not.toContain('disabled=""');
    expect(submit(true)).toContain('Вручить');
  });
});

describe('grant dialog empty state (ADR-0061 amendment 1)', () => {
  const empty = (canManage: boolean): string => renderToStaticMarkup(createElement(GrantEmpty, { canManage, onOpenSettings: () => undefined }));

  it('says the workspace has no achievements yet', () => {
    expect(empty(false)).toContain('В пространстве ещё нет ачивок');
  });

  it('«Открыть настройки» only for MANAGE_WORKSPACE', () => {
    expect(empty(true)).toContain('Открыть настройки');
    expect(empty(false)).not.toContain('Открыть настройки');
  });
});
