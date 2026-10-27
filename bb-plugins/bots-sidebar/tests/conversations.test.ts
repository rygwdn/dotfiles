import { describe, expect, it } from "vitest";
import { conversationOwners } from "../lib/conversations";
import { thread } from "./fixtures";


describe("explicit conversation ownership", () => {
  it("inherits the nearest binding across projects and honors an explicit child override", () => {
    const owners = conversationOwners([
      thread("root", 1), thread("child", 2, { parentThreadId: "root", projectId: "other-project" }),
      thread("override", 3, { parentThreadId: "child" }), thread("grandchild", 4, { parentThreadId: "override" }),
      thread("unassigned", 5),
    ], [{ threadId: "root", botId: "one" }, { threadId: "override", botId: "two" }]);
    expect([...owners]).toEqual([["root", "one"], ["child", "one"], ["override", "two"], ["grandchild", "two"]]);
  });
  it("uses a known ancestor binding even when that ancestor is not loaded", () => {
    expect(conversationOwners([thread("child", 1, { parentThreadId: "missing" })], [{ threadId: "missing", botId: "one" }]).get("child")).toBe("one");
  });
  it("does not infer ownership from a project or loop on malformed parent cycles", () => {
    const owners = conversationOwners([
      thread("one", 1, { parentThreadId: "two" }), thread("two", 1, { parentThreadId: "one" }), thread("unassigned", 1),
    ], []);
    expect(owners.size).toBe(0);
  });
});

