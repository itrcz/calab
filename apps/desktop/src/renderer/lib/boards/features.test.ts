import { BoardFeature, EstimateScale, TaskField } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { FEATURES, estimateName, featureOn, fieldOff, groupOn, isSized, scaleValues, sortOn, withFeature } from './features';

describe('board features (ADR-0058 §3)', () => {
  it('lists all 16 features once, in enum order', () => {
    expect(FEATURES.map((f) => f.feature)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('every optional feature is switchable, including forms, automations and Git links (owner 07.10)', () => {
    const listed = FEATURES.map((f) => f.feature);
    for (const f of [BoardFeature.START_DATE, BoardFeature.FORMS, BoardFeature.AUTOMATIONS, BoardFeature.GIT_LINKS]) {
      expect(listed).toContain(f);
      expect(featureOn(withFeature(undefined, f, false), f)).toBe(false);
      expect(featureOn(withFeature([f], f, true), f)).toBe(true);
    }
    // Every enum member (but UNSPECIFIED) is offered: a feature added to the proto cannot be forgotten.
    const all = Object.values(BoardFeature).filter((v): v is BoardFeature => typeof v === 'number' && v !== BoardFeature.UNSPECIFIED);
    expect([...listed].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
  });

  it('stores the disabled set ascending without duplicates (empty = all on)', () => {
    expect(featureOn(undefined, BoardFeature.ESTIMATE)).toBe(true);
    expect(featureOn([BoardFeature.ESTIMATE], BoardFeature.ESTIMATE)).toBe(false);
    expect(withFeature([BoardFeature.TIMELINE], BoardFeature.ESTIMATE, false)).toEqual([BoardFeature.ESTIMATE, BoardFeature.TIMELINE]);
    expect(withFeature([BoardFeature.ESTIMATE, BoardFeature.ESTIMATE], BoardFeature.ESTIMATE, false)).toEqual([BoardFeature.ESTIMATE]);
    expect(withFeature([BoardFeature.ESTIMATE, BoardFeature.LABELS], BoardFeature.ESTIMATE, true)).toEqual([BoardFeature.LABELS]);
    expect(withFeature([BoardFeature.UNSPECIFIED], BoardFeature.LABELS, true)).toEqual([]);
  });

  it('maps filter fields to their feature; fields without one are never off', () => {
    const off = [BoardFeature.DUE_DATE, BoardFeature.APPROVALS];
    expect(fieldOff(off, TaskField.DUE_ON)).toBe(true);
    expect(fieldOff(off, TaskField.APPROVER_PENDING)).toBe(true);
    expect(fieldOff(off, TaskField.APPROVAL_STATE)).toBe(true);
    expect(fieldOff(off, TaskField.START_ON)).toBe(false);
    expect(fieldOff(off, TaskField.STATUS)).toBe(false);
    expect(fieldOff(off, TaskField.ASSIGNEE)).toBe(false);
  });

  it('list grouping / sort by a disabled feature is not offered', () => {
    expect(groupOn('priority', [BoardFeature.PRIORITY])).toBe(false);
    expect(groupOn('status', [BoardFeature.PRIORITY])).toBe(true);
    expect(groupOn('milestone', [BoardFeature.LABELS])).toBe(true);
    expect(sortOn('due', [BoardFeature.DUE_DATE])).toBe(false);
    expect(sortOn('manual', [BoardFeature.DUE_DATE])).toBe(true);
  });

  it('estimate scales: values and names; outside the scale shows the number', () => {
    expect(scaleValues(EstimateScale.FIBONACCI)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(scaleValues(EstimateScale.UNSPECIFIED)).toEqual([1, 2, 3, 5, 8, 13, 21]);
    expect(scaleValues(EstimateScale.LINEAR)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(scaleValues(EstimateScale.TSHIRT)).toEqual([1, 2, 3, 5, 8]);
    expect(estimateName(3, EstimateScale.TSHIRT)).toBe('M');
    expect(estimateName(13, EstimateScale.TSHIRT)).toBe('13');
    expect(isSized(13, EstimateScale.TSHIRT)).toBe(false);
    expect(isSized(8, EstimateScale.TSHIRT)).toBe(true);
    expect(estimateName(5, EstimateScale.LINEAR)).toBe('5');
  });
});
