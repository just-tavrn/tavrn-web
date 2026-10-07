// SPDX-License-Identifier: Apache-2.0
/**
 * Invite validity choices (design note 4.13 item 8): `create_invites` alone may choose up to 30 days (default
 * 7), `manage_room` also "never" (`expires_hours: 0`) and longer validity. The node enforces the same rules.
 */

/** Hours; `0` = never expires. */
export const EXPIRY_HOURS = [1, 24, 168, 720] as const;
export const DEFAULT_EXPIRY_HOURS = 168;
export const MAX_USES_CHOICES = [0, 1, 5, 10, 25, 50, 100] as const;

/** The validity choices for a member: never only with `manage_room`. */
export function expiryChoices(manageRoom: boolean): number[] {
  return manageRoom ? [...EXPIRY_HOURS, 0] : [...EXPIRY_HOURS];
}

/** Is an invite still usable at `now` (not expired, uses left)? */
export function inviteActive(i: { expires_at?: string | null; max_uses: number; uses: number }, now = Date.now()): boolean {
  if (i.expires_at && Date.parse(i.expires_at) <= now) return false;
  return i.max_uses === 0 || i.uses < i.max_uses;
}
