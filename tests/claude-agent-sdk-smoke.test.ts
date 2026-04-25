/**
 * SDK smoke test — Gate 2.1 of Miracle v1 slice.
 *
 * Proves that @anthropic-ai/claude-agent-sdk imports resolve under our Bun
 * runtime + TypeScript config, and that the specific symbols the slice
 * depends on (query, InMemorySessionStore, SessionKey shape) are available
 * at the expected names. The SDK's SessionStore surface is marked @alpha;
 * this catches silent breakage when we bump the SDK.
 *
 * NOT a network test — no API calls, no real query() invocation. Those
 * land in Gate 2.2 integration smokes.
 */

import { describe, it, expect } from "vitest";
import { query, InMemorySessionStore, type SessionKey } from "@anthropic-ai/claude-agent-sdk";

describe("claude-agent-sdk smoke", () => {
  it("exports query as a function", () => {
    expect(typeof query).toBe("function");
  });

  it("exports InMemorySessionStore as a constructible class with the persistence surface we rely on", () => {
    const store = new InMemorySessionStore();
    expect(store).toBeDefined();
    expect(typeof store.append).toBe("function");
    expect(typeof store.load).toBe("function");
    expect(typeof store.delete).toBe("function");
  });

  it("SessionKey type has the shape the slice relies on", () => {
    const key: SessionKey = {
      projectKey: "test-project",
      sessionId: "00000000-0000-0000-0000-000000000000",
    };
    expect(key.projectKey).toBe("test-project");
    expect(key.sessionId).toBe("00000000-0000-0000-0000-000000000000");
  });
});
