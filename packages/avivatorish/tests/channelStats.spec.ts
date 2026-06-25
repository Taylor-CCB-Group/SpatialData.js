import { describe, expect, it } from 'vitest';
import { pickDefaultSelectionForAdd, selectionStatsKey } from '../src/channelStats';

describe('selectionStatsKey', () => {
  it('includes channelId and the full z/c/t selection', () => {
    expect(selectionStatsKey('ch-a', { z: 2, c: 3, t: 1 }, 0)).toBe('ch-a:2:3:1');
  });

  it('falls back to the row index for c and 0 for z/t when absent', () => {
    expect(selectionStatsKey('ch-a', {}, 4)).toBe('ch-a:0:4:0');
    expect(selectionStatsKey('ch-a', undefined, 4)).toBe('ch-a:0:4:0');
  });

  it('changes when the selection changes for the same channel', () => {
    const a = selectionStatsKey('ch-a', { c: 0 }, 0);
    const b = selectionStatsKey('ch-a', { c: 1 }, 0);
    expect(a).not.toBe(b);
  });
});

describe('pickDefaultSelectionForAdd', () => {
  const names = ['DAPI', 'GFP', 'RFP'];

  it('picks the first unused channel index', () => {
    expect(pickDefaultSelectionForAdd([{ c: 0 }], names)).toBe(1);
    expect(pickDefaultSelectionForAdd([{ c: 0 }, { c: 1 }], names)).toBe(2);
  });

  it('treats an absent c as channel 0', () => {
    expect(pickDefaultSelectionForAdd([{}], names)).toBe(1);
  });

  it('returns 0 when every channel is already used', () => {
    expect(pickDefaultSelectionForAdd([{ c: 0 }, { c: 1 }, { c: 2 }], names)).toBe(0);
  });

  it('returns 0 when there are no channel names', () => {
    expect(pickDefaultSelectionForAdd([], [])).toBe(0);
  });
});
