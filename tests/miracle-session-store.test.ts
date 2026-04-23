import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSliceDb, _resetSliceDbForTests } from "../src/miracle/db";
import { SqliteSessionStore } from "../src/miracle/session-store";

const TEST_DB = join(tmpdir(), `miracle-session-test-${process.pid}.db`);

function cleanup(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {
      /* ignore */
    }
  }
}

describe("SqliteSessionStore", () => {
  beforeEach(() => {
    _resetSliceDbForTests();
    cleanup();
  });

  afterAll(() => {
    _resetSliceDbForTests();
    cleanup();
  });

  function freshStore() {
    const db = getSliceDb({ MIRACLE_SLICE_DB_PATH: TEST_DB });
    return new SqliteSessionStore(db);
  }

  it("round-trips entries via append + load", async () => {
    const store = freshStore();
    const key = { projectKey: "miracle-slice", sessionId: "s1" };
    await store.append(key, [
      { type: "user", uuid: "u1", timestamp: "2026-04-23T00:00:00Z" },
      { type: "assistant", uuid: "a1", timestamp: "2026-04-23T00:00:01Z" },
    ]);

    const loaded = await store.load(key);
    expect(loaded).toHaveLength(2);
    expect(loaded![0]).toMatchObject({ type: "user", uuid: "u1" });
    expect(loaded![1]).toMatchObject({ type: "assistant", uuid: "a1" });
  });

  it("appends accumulate across multiple calls", async () => {
    const store = freshStore();
    const key = { projectKey: "miracle-slice", sessionId: "s1" };
    await store.append(key, [{ type: "user", uuid: "u1" }]);
    await store.append(key, [{ type: "assistant", uuid: "a1" }]);
    await store.append(key, [{ type: "user", uuid: "u2" }]);

    const loaded = await store.load(key);
    expect(loaded).toHaveLength(3);
    expect(loaded!.map((e) => e.uuid)).toEqual(["u1", "a1", "u2"]);
  });

  it("returns null for an unknown key", async () => {
    const store = freshStore();
    const loaded = await store.load({
      projectKey: "miracle-slice",
      sessionId: "never-existed",
    });
    expect(loaded).toBeNull();
  });

  it("empty append is a no-op", async () => {
    const store = freshStore();
    const key = { projectKey: "miracle-slice", sessionId: "s1" };
    await store.append(key, []);
    const loaded = await store.load(key);
    expect(loaded).toBeNull();
  });

  it("treats subpath as part of the key (different subpath = different session)", async () => {
    const store = freshStore();
    const main = { projectKey: "miracle-slice", sessionId: "s1" };
    const sub = { projectKey: "miracle-slice", sessionId: "s1", subpath: "sub-a" };

    await store.append(main, [{ type: "user", uuid: "m1" }]);
    await store.append(sub, [{ type: "user", uuid: "s1-sub" }]);

    const mainLoad = await store.load(main);
    const subLoad = await store.load(sub);

    expect(mainLoad).toHaveLength(1);
    expect(subLoad).toHaveLength(1);
    expect(mainLoad?.[0]?.uuid).toBe("m1");
    expect(subLoad?.[0]?.uuid).toBe("s1-sub");
  });

  it("delete removes a session", async () => {
    const store = freshStore();
    const key = { projectKey: "miracle-slice", sessionId: "s1" };
    await store.append(key, [{ type: "user", uuid: "u1" }]);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
  });

  it("listSessions groups by sessionId within a projectKey and sorts mtime-desc", async () => {
    const store = freshStore();
    await store.append(
      { projectKey: "miracle-slice", sessionId: "old" },
      [{ type: "user", uuid: "o1" }],
    );
    // Force a distinct mtime.
    await new Promise((r) => setTimeout(r, 3));
    await store.append(
      { projectKey: "miracle-slice", sessionId: "new" },
      [{ type: "user", uuid: "n1" }],
    );

    const sessions = await store.listSessions("miracle-slice");
    expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("listSessions excludes other projectKeys", async () => {
    const store = freshStore();
    await store.append(
      { projectKey: "miracle-slice", sessionId: "mine" },
      [{ type: "user", uuid: "m" }],
    );
    await store.append(
      { projectKey: "other-project", sessionId: "theirs" },
      [{ type: "user", uuid: "t" }],
    );

    const mine = await store.listSessions("miracle-slice");
    expect(mine.map((s) => s.sessionId)).toEqual(["mine"]);
  });

  it("listSubkeys returns subpaths for a session", async () => {
    const store = freshStore();
    await store.append(
      { projectKey: "miracle-slice", sessionId: "s1" },
      [{ type: "user" }],
    );
    await store.append(
      { projectKey: "miracle-slice", sessionId: "s1", subpath: "agent-1" },
      [{ type: "user" }],
    );
    await store.append(
      { projectKey: "miracle-slice", sessionId: "s1", subpath: "agent-2" },
      [{ type: "user" }],
    );

    const subkeys = await store.listSubkeys({
      projectKey: "miracle-slice",
      sessionId: "s1",
    });
    expect(subkeys.sort()).toEqual(["agent-1", "agent-2"]);
  });
});
