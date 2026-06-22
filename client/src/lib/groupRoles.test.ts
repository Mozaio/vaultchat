import assert from "node:assert/strict";
import test from "node:test";
import {
  canDemote,
  canKick,
  canPromote,
  effectiveAdminIds,
  isGroupAdmin,
  isGroupCreator,
} from "./groupRoles";
import type { ApiGroup } from "./api";

const CREATOR = "creator";
const ADMIN = "admin";
const MEMBER = "member";

function group(overrides: Partial<ApiGroup> = {}): ApiGroup {
  return {
    id: "g1",
    name: "g",
    memberIds: [CREATOR, ADMIN, MEMBER],
    adminIds: [CREATOR, ADMIN],
    createdByUserId: CREATOR,
    createdAt: 1,
    ...overrides,
  };
}

test("creator is always an admin even without adminIds", () => {
  const g = group({ adminIds: [] });
  assert.equal(isGroupAdmin(g, CREATOR), true);
  assert.ok(effectiveAdminIds(g).has(CREATOR));
});

test("old server without createdByUserId and adminIds grants no admin UI", () => {
  const g: ApiGroup = {
    id: "g",
    name: "g",
    memberIds: [MEMBER],
    createdAt: 1,
  };
  assert.equal(effectiveAdminIds(g).size, 0);
  assert.equal(isGroupAdmin(g, MEMBER), false);
});

test("isGroupCreator basics", () => {
  const g = group();
  assert.equal(isGroupCreator(g, CREATOR), true);
  assert.equal(isGroupCreator(g, ADMIN), false);
});

test("canKick: admin kicks member; member cannot; creator unkickable", () => {
  const g = group();
  assert.equal(canKick(g, ADMIN, MEMBER), true);
  assert.equal(canKick(g, MEMBER, ADMIN), false);
  assert.equal(canKick(g, ADMIN, CREATOR), false);
  // admin cannot kick another admin (only creator can)
  assert.equal(canKick(g, ADMIN, CREATOR), false);
  // self is not a "kick" in the UI
  assert.equal(canKick(g, MEMBER, MEMBER), false);
});

test("canPromote: only admins promote non-admin members", () => {
  const g = group();
  assert.equal(canPromote(g, ADMIN, MEMBER), true);
  assert.equal(canPromote(g, MEMBER, MEMBER), false);
  // already admin -> cannot promote
  assert.equal(canPromote(g, CREATOR, ADMIN), false);
});

test("canDemote: only the creator demotes admins, never the creator", () => {
  const g = group();
  assert.equal(canDemote(g, CREATOR, ADMIN), true);
  assert.equal(canDemote(g, ADMIN, CREATOR), false);
  assert.equal(canDemote(g, CREATOR, CREATOR), false);
  assert.equal(canDemote(g, CREATOR, MEMBER), false);
});
