import { describe, expect, it } from 'vitest';
import { uploadLimitsOf } from './uploadLimits';

describe('admin upload limits form (ADR-0155)', () => {
  it('empty fields follow the server default, values go as numbers', () => {
    expect(uploadLimitsOf({ burst: '', perHour: '600', maxFileMb: ' ' }, 4096)).toEqual({ limits: { perHour: 600 } });
  });

  it('a value out of range names its field and the maximum', () => {
    expect(uploadLimitsOf({ burst: '0', perHour: '', maxFileMb: '' }, 4096)).toEqual({ error: { field: 'burst', max: 10000 } });
    expect(uploadLimitsOf({ burst: '', perHour: '', maxFileMb: '4097' }, 4096)).toEqual({ error: { field: 'maxFileMb', max: 4096 } });
  });
});
