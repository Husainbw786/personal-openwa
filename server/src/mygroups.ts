import { getSetting, setSetting } from './db.ts';
import { loadGroupMembers } from './members.ts';

/**
 * "My groups": groups you run (e.g. your community). Members of any other group or list who are
 * already in one of these get an "In <group>" tag, and you can filter to people who aren't yet.
 * Membership comes from the warm member cache, so this costs no extra WhatsApp calls.
 */
export interface MyGroup {
  sessionId: string; // which linked number can read the group
  groupId: string;
  name: string;
}

export function getMyGroups(): MyGroup[] {
  try {
    const list = JSON.parse(getSetting('my_groups', '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function setMyGroup(group: MyGroup, mine: boolean): MyGroup[] {
  const rest = getMyGroups().filter((g) => g.groupId !== group.groupId);
  const next = mine ? [...rest, group] : rest;
  setSetting('my_groups', JSON.stringify(next));
  return next;
}

/** phone/recipient key → names of my groups they're in. Skips `currentGroupId` (no point tagging a group with itself). */
export async function myGroupMembership(currentGroupId?: string): Promise<Map<string, string[]>> {
  const membership = new Map<string, string[]>();
  for (const g of getMyGroups()) {
    if (g.groupId === currentGroupId) continue;
    const data = await loadGroupMembers(g.sessionId, g.groupId).catch(() => null);
    if (!data) continue;
    for (const m of data.members) {
      const names = membership.get(m.phone);
      if (names) names.push(g.name);
      else membership.set(m.phone, [g.name]);
    }
  }
  return membership;
}
