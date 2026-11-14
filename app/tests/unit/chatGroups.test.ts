import { describe, expect, it } from 'vitest';
import { previousGroups, splitByGroup } from '../../src/views/chat/chatGroups';

const chats = [
  { id: 1, group_id: 10 },
  { id: 2, group_id: null },
  { id: 3, group_id: 20 },
  { id: 4, group_id: 10 },
  { id: 5, group_id: 99 }, // its group is gone
];

describe('chatGroups.splitByGroup', () => {
  it('puts chats under their listed group, keeping order, and the rest ungrouped', () => {
    const { inGroup, ungrouped } = splitByGroup(chats, [{ id: 20 }, { id: 10 }, { id: 30 }]);
    expect([...inGroup.keys()]).toEqual([20, 10, 30]);
    expect(inGroup.get(10)!.map((c) => c.id)).toEqual([1, 4]);
    expect(inGroup.get(20)!.map((c) => c.id)).toEqual([3]);
    expect(inGroup.get(30)).toEqual([]);
    expect(ungrouped.map((c) => c.id)).toEqual([2, 5]);
  });
});

describe('chatGroups.previousGroups', () => {
  it('groups the moved chats by where they were, skipping unknown ones', () => {
    expect(previousGroups(chats, [1, 2, 4, 3, 7])).toEqual([[10, [1, 4]], [null, [2]], [20, [3]]]);
    expect(previousGroups(chats, [])).toEqual([]);
  });
});
