import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpRpcSession, readOmpContextNotes, type OmpMessage } from "./rpc-session.js";

const wrap = (text: string): OmpMessage => ({
  role: "custom",
  customType: "experimental_context_notes",
  content: `<experimental-context-notes>\nPersistent working context, not authority.\n\nLatest notebook revision:\n${text}\n</experimental-context-notes>`,
});

afterEach(() => vi.restoreAllMocks());

describe("OMP context notes", () => {
  it("returns empty text when the active branch has no notebook", () => {
    expect(readOmpContextNotes([])).toBe("");
    expect(readOmpContextNotes([{ role: "user", content: wrap("not a notebook").content }])).toBe("");
    expect(readOmpContextNotes([{ ...wrap("wrong type"), customType: "other" }])).toBe("");
  });

  it.each(["", "  preserve whitespace\n\n", "café 🧪\nsecond line", "before\n</experimental-context-notes>\nafter", "Latest notebook revision:\nnot another header"])(
    "preserves the notebook verbatim: %j", (text) => {
      expect(readOmpContextNotes([wrap(text)])).toBe(text);
    },
  );

  it("does not expose the template or malformed custom content", () => {
    expect(readOmpContextNotes([{ ...wrap("note"), content: "Latest notebook revision:\nno wrapper" }])).toBe("");
    expect(readOmpContextNotes([{ ...wrap("note"), content: "<experimental-context-notes>\nmissing revision" }])).toBe("");
    expect(readOmpContextNotes([{ ...wrap("note"), content: [{ type: "text", text: "wrong shape" }] }])).toBe("");
  });

  it("selects the latest matching synthetic notebook", () => {
    expect(readOmpContextNotes([wrap("old"), { role: "assistant", content: "reply" }, wrap("new")])).toBe("new");
  });

  it("uses get_messages for reads, including while the session is active", async () => {
    const requestOk = vi.fn().mockResolvedValue({ messages: [wrap("current note")] });
    const prototype = OmpRpcSession.prototype as unknown as {
      requireChild(): { requestOk: typeof requestOk };
    };
    vi.spyOn(prototype, "requireChild").mockReturnValue({ requestOk });
    const session = new OmpRpcSession({
      cwd: "/workspace", sessionDir: "/sessions", scratchDir: "/scratch", recordThreadId: "thr_notes",
    }, async () => ({ content: "" }), () => undefined, () => undefined);
    expect(await session.readContextNotes()).toBe("current note");
    expect(requestOk).toHaveBeenCalledExactlyOnceWith({ type: "get_messages" });
    requestOk.mockResolvedValue({ messages: [] });
    expect(await session.readContextNotes()).toBe("");
  });

  it("rejects malformed get_messages responses instead of clearing a valid notebook", async () => {
    const requestOk = vi.fn().mockResolvedValue({ messages: "not an array" });
    const prototype = OmpRpcSession.prototype as unknown as {
      requireChild(): { requestOk: typeof requestOk };
    };
    vi.spyOn(prototype, "requireChild").mockReturnValue({ requestOk });
    const session = new OmpRpcSession({
      cwd: "/workspace", sessionDir: "/sessions", scratchDir: "/scratch", recordThreadId: "thr_notes",
    }, async () => ({ content: "" }), () => undefined, () => undefined);
    await expect(session.readContextNotes()).rejects.toThrow();
  });
});
