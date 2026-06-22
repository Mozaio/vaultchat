import assert from "node:assert/strict";
import test from "node:test";
import {
  addGroupMember,
  addGroupMemberByInvite,
  createGroup,
  createUser,
  demoteGroupAdmin,
  getGroupAdminIds,
  promoteGroupAdmin,
  removeGroupMember,
  updateGroupProfile,
} from "./memoryStore.js";

// Integration over the live (RAM-only) store: verifies that the role policy in
// groupRoles.ts is actually enforced by the membership mutators.

function mkUser(name: string): string {
  const u = createUser({
    username: name + "-" + Math.random().toString(36).slice(2),
    passwordHash: "argon2",
    publicKey: "pk-" + name,
  });
  assert.ok(u, "user created");
  return u!.id;
}

test("createGroup makes the creator the sole admin", () => {
  const creator = mkUser("creator");
  const m1 = mkUser("m1");
  const g = createGroup({ name: "g", memberIds: [creator, m1], createdByUserId: creator });
  const admins = getGroupAdminIds(g.id);
  assert.deepEqual(admins, [creator]);
});

test("a plain member cannot add a member; an admin can", () => {
  const creator = mkUser("creator");
  const member = mkUser("member");
  const newbie = mkUser("newbie");
  const g = createGroup({ name: "g", memberIds: [creator, member], createdByUserId: creator });

  // member (non-admin) tries to add -> denied
  assert.equal(addGroupMember(g.id, member, newbie), null);
  // creator (admin) adds -> ok
  const after = addGroupMember(g.id, creator, newbie);
  assert.ok(after);
  assert.ok(after!.memberIds.includes(newbie));
});

test("a plain member cannot kick another member; an admin can", () => {
  const creator = mkUser("creator");
  const a = mkUser("a");
  const b = mkUser("b");
  const g = createGroup({ name: "g", memberIds: [creator, a, b], createdByUserId: creator });

  // a (non-admin) tries to kick b -> denied
  assert.equal(removeGroupMember(g.id, a, b), null);
  // creator (admin) kicks b -> ok
  const after = removeGroupMember(g.id, creator, b);
  assert.ok(after);
  assert.ok(!after!.memberIds.includes(b));
});

test("the creator cannot be kicked by an admin", () => {
  const creator = mkUser("creator");
  const admin = mkUser("admin");
  const g = createGroup({ name: "g", memberIds: [creator, admin], createdByUserId: creator });
  promoteGroupAdmin(g.id, creator, admin);

  // admin tries to kick creator -> denied
  assert.equal(removeGroupMember(g.id, admin, creator), null);
});

test("an admin cannot kick another admin; the creator can", () => {
  const creator = mkUser("creator");
  const a1 = mkUser("a1");
  const a2 = mkUser("a2");
  const g = createGroup({ name: "g", memberIds: [creator, a1, a2], createdByUserId: creator });
  promoteGroupAdmin(g.id, creator, a1);
  promoteGroupAdmin(g.id, creator, a2);

  // a1 tries to kick a2 (both admins) -> denied
  assert.equal(removeGroupMember(g.id, a1, a2), null);
  // creator kicks a2 -> ok, and a2 drops out of adminIds too
  const after = removeGroupMember(g.id, creator, a2);
  assert.ok(after);
  assert.ok(!after!.memberIds.includes(a2));
  assert.ok(!getGroupAdminIds(g.id)!.includes(a2));
});

test("anyone can leave (self-remove) regardless of role", () => {
  const creator = mkUser("creator");
  const member = mkUser("member");
  const g = createGroup({ name: "g", memberIds: [creator, member], createdByUserId: creator });
  const after = removeGroupMember(g.id, member, member);
  assert.ok(after);
  assert.ok(!after!.memberIds.includes(member));
});

test("promote/demote: only creator demotes; non-admins cannot promote", () => {
  const creator = mkUser("creator");
  const admin = mkUser("admin");
  const member = mkUser("member");
  const g = createGroup({ name: "g", memberIds: [creator, admin, member], createdByUserId: creator });

  // promote admin (by creator)
  assert.ok(promoteGroupAdmin(g.id, creator, admin));
  assert.ok(getGroupAdminIds(g.id)!.includes(admin));

  // a plain member cannot promote anyone
  assert.equal(promoteGroupAdmin(g.id, member, creator), null);

  // an admin (non-creator) cannot demote another admin
  assert.equal(demoteGroupAdmin(g.id, admin, creator), null);

  // creator demotes admin -> ok
  assert.ok(demoteGroupAdmin(g.id, creator, admin));
  assert.ok(!getGroupAdminIds(g.id)!.includes(admin));

  // creator cannot be demoted
  assert.equal(demoteGroupAdmin(g.id, creator, creator), null);
});

test("only admins can update the group profile", () => {
  const creator = mkUser("creator");
  const member = mkUser("member");
  const g = createGroup({ name: "g", memberIds: [creator, member], createdByUserId: creator });

  assert.equal(updateGroupProfile(g.id, member, { name: "hacked" }), null);
  const after = updateGroupProfile(g.id, creator, { name: "renamed" });
  assert.ok(after);
  assert.equal(after!.name, "renamed");
});

test("invite-redeem path adds members without an admin actor", () => {
  const creator = mkUser("creator");
  const joiner = mkUser("joiner");
  const g = createGroup({ name: "g", memberIds: [creator], createdByUserId: creator });
  // token-authorized add (no role actor) succeeds
  const after = addGroupMemberByInvite(g.id, joiner);
  assert.ok(after);
  assert.ok(after!.memberIds.includes(joiner));
  // and the joiner is NOT an admin
  assert.ok(!getGroupAdminIds(g.id)!.includes(joiner));
});
