import assert from "node:assert/strict";
import test from "node:test";
import {
  canAddMember,
  canDemote,
  canManageInvites,
  canPromote,
  canRemoveMember,
  canUpdateProfile,
  effectiveAdminIds,
  isAdmin,
  isCreator,
  isMember,
  type GroupRoleView,
} from "./groupRoles.js";

const CREATOR = "creator";
const ADMIN = "admin";
const MEMBER = "member";
const OTHER = "other";
const OUTSIDER = "outsider";

function group(overrides: Partial<GroupRoleView> = {}): GroupRoleView {
  return {
    createdByUserId: CREATOR,
    memberIds: [CREATOR, ADMIN, MEMBER, OTHER],
    adminIds: [ADMIN],
    ...overrides,
  };
}

test("creator is always an admin even without explicit adminIds", () => {
  const g = group({ adminIds: [] });
  assert.equal(isAdmin(g, CREATOR), true);
  assert.ok(effectiveAdminIds(g).has(CREATOR));
});

test("legacy group with no adminIds field: only the creator is admin", () => {
  const g: GroupRoleView = {
    createdByUserId: CREATOR,
    memberIds: [CREATOR, MEMBER],
  };
  assert.equal(isAdmin(g, CREATOR), true);
  assert.equal(isAdmin(g, MEMBER), false);
});

test("a non-member listed in adminIds is not treated as admin", () => {
  const g = group({ adminIds: [ADMIN, OUTSIDER], memberIds: [CREATOR, ADMIN, MEMBER] });
  const admins = effectiveAdminIds(g);
  assert.ok(admins.has(ADMIN));
  assert.ok(!admins.has(OUTSIDER));
});

test("creator who left the member set is no longer admin", () => {
  const g = group({ memberIds: [ADMIN, MEMBER], adminIds: [ADMIN] });
  assert.equal(isAdmin(g, CREATOR), false);
  assert.equal(isMember(g, CREATOR), false);
});

test("isCreator / isMember basics", () => {
  const g = group();
  assert.equal(isCreator(g, CREATOR), true);
  assert.equal(isCreator(g, ADMIN), false);
  assert.equal(isMember(g, MEMBER), true);
  assert.equal(isMember(g, OUTSIDER), false);
});

test("only admins can add members", () => {
  const g = group();
  assert.equal(canAddMember(g, CREATOR), true);
  assert.equal(canAddMember(g, ADMIN), true);
  assert.equal(canAddMember(g, MEMBER), false);
  assert.equal(canAddMember(g, OUTSIDER), false);
});

test("only admins manage invites and profile", () => {
  const g = group();
  assert.equal(canManageInvites(g, ADMIN), true);
  assert.equal(canManageInvites(g, MEMBER), false);
  assert.equal(canUpdateProfile(g, CREATOR), true);
  assert.equal(canUpdateProfile(g, MEMBER), false);
});

test("anyone can remove themselves (leave)", () => {
  const g = group();
  assert.equal(canRemoveMember(g, MEMBER, MEMBER), true);
  assert.equal(canRemoveMember(g, ADMIN, ADMIN), true);
  assert.equal(canRemoveMember(g, CREATOR, CREATOR), true);
});

test("a plain member cannot kick anyone else", () => {
  const g = group();
  assert.equal(canRemoveMember(g, MEMBER, OTHER), false);
  assert.equal(canRemoveMember(g, MEMBER, ADMIN), false);
});

test("an admin can kick a plain member", () => {
  const g = group();
  assert.equal(canRemoveMember(g, ADMIN, MEMBER), true);
  assert.equal(canRemoveMember(g, ADMIN, OTHER), true);
});

test("the creator cannot be kicked by an admin", () => {
  const g = group();
  assert.equal(canRemoveMember(g, ADMIN, CREATOR), false);
});

test("an admin cannot kick another admin; only the creator can", () => {
  const g = group({ adminIds: [ADMIN, OTHER] });
  // ADMIN tries to kick OTHER (also admin) -> denied
  assert.equal(canRemoveMember(g, ADMIN, OTHER), false);
  // creator kicks an admin -> allowed
  assert.equal(canRemoveMember(g, CREATOR, ADMIN), true);
  assert.equal(canRemoveMember(g, CREATOR, OTHER), true);
});

test("promotion: admins can promote members; non-admins cannot", () => {
  const g = group();
  assert.equal(canPromote(g, ADMIN, MEMBER), true);
  assert.equal(canPromote(g, CREATOR, MEMBER), true);
  assert.equal(canPromote(g, MEMBER, OTHER), false);
  // cannot promote a non-member
  assert.equal(canPromote(g, ADMIN, OUTSIDER), false);
});

test("demotion: only the creator can demote an admin, never the creator", () => {
  const g = group({ adminIds: [ADMIN, OTHER] });
  assert.equal(canDemote(g, CREATOR, ADMIN), true);
  assert.equal(canDemote(g, CREATOR, OTHER), true);
  // an admin cannot demote another admin
  assert.equal(canDemote(g, ADMIN, OTHER), false);
  // creator cannot be demoted
  assert.equal(canDemote(g, CREATOR, CREATOR), false);
  // demoting a non-admin is a no-op (denied)
  assert.equal(canDemote(g, CREATOR, MEMBER), false);
});
