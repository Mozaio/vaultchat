import assert from "node:assert/strict";
import test from "node:test";
import { reduceChatMessages, type Authored } from "./chatReducer";

function frame(
  plain: Record<string, unknown>,
  fromMe = true,
  at = Date.now()
): Authored {
  return {
    id: `row-${plain.cid ?? Math.random()}`,
    fromMe,
    plainJson: JSON.stringify({ v: 2, ...plain }),
    at,
  };
}

test("reaction frames update, toggle, and do not render as bubbles", () => {
  const rows = [
    frame({ cid: "m1", kind: "text", body: "Hello" }, true, 1),
    frame({ cid: "r1", kind: "reaction", refCid: "m1", emoji: "👍" }, false, 2),
    frame({ cid: "r2", kind: "reaction", refCid: "m1", emoji: "❤️" }, true, 3),
    frame({ cid: "r3", kind: "reaction", refCid: "m1", emoji: "" }, true, 4),
  ];

  const messages = reduceChatMessages(rows);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.reactions, { "👍": 1 });
  assert.equal(messages[0]?.myReaction, undefined);
});

test("changing your reaction replaces the previous emoji", () => {
  const rows = [
    frame({ cid: "m1", kind: "text", body: "Hello" }, false, 1),
    frame({ cid: "r1", kind: "reaction", refCid: "m1", emoji: "👍" }, true, 2),
    frame({ cid: "r2", kind: "reaction", refCid: "m1", emoji: "✅" }, true, 3),
  ];

  const messages = reduceChatMessages(rows);

  assert.deepEqual(messages[0]?.reactions, { "✅": 1 });
  assert.equal(messages[0]?.myReaction, "✅");
});
