import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { buildYjsOutboxSyncRequest, fromBase64, getDraft, setDraft, toBase64 } from "./yjs";

describe("frontend yjs outbox", () => {
  test("coalesces queued updates per doc without losing the latest draft", () => {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));

    setDraft(doc, "first");
    setDraft(doc, "second");

    const request = buildYjsOutboxSyncRequest(
      updates.map((update) => ({
        docId: "chat:v3:session-a",
        sessionDbId: "v3:session-a",
        update: toBase64(update),
      })),
    );

    expect(request.docs).toHaveLength(1);
    const merged = request.docs[0]?.update;
    expect(typeof merged).toBe("string");

    const restored = new Y.Doc();
    Y.applyUpdate(restored, fromBase64(merged!));
    expect(getDraft(restored)).toBe("second");
  });
});
