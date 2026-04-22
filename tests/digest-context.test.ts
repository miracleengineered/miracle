import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock child_process BEFORE importing the module under test — digest-context
// spawns subject-search.ts via execFile. Tests cover both success + timeout.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { buildDigestContextPrefix } from "../src/handlers/digest-context";

const mockExecFile = vi.mocked(execFile);

// Temp cache dir fixture — redirects snapshot reads away from
// ~/Library/Caches/ so tests don't collide with real digest snapshots.
let fixtureDir: string;

function writeSnapshot(filename: string, payload: unknown): void {
  writeFileSync(join(fixtureDir, filename), JSON.stringify(payload));
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "digest-context-test-"));
  process.env.DIGEST_CONTEXT_CACHE_DIR = fixtureDir;
  mockExecFile.mockReset();
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  delete process.env.DIGEST_CONTEXT_CACHE_DIR;
});

describe("section drill-down", () => {
  it("injects context for 'more on 3' when morning snapshot has section 3", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [
        { n: 1, module: "weather", content: "Detroit 52F" },
        { n: 2, module: "today", content: "Focus items" },
        { n: 3, module: "news", content: "AI news bullets" },
        { n: 4, module: "tip", content: "Strategic tip" },
      ],
    });

    const prefix = await buildDigestContextPrefix("more on 3");

    expect(prefix).toContain("[Drill-down — section 3 (news)");
    expect(prefix).toContain("morning-digest");
    expect(prefix).toContain("AI news bullets");
    expect(prefix.endsWith("\n\n")).toBe(true);
  });

  it("bare digit 'N' triggers drill-down", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [{ n: 2, module: "today", content: "Today priorities" }],
    });

    const prefix = await buildDigestContextPrefix("2");

    expect(prefix).toContain("section 2");
    expect(prefix).toContain("Today priorities");
  });

  it("'expand N' triggers drill-down", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [{ n: 4, module: "tip", content: "The tip" }],
    });

    const prefix = await buildDigestContextPrefix("expand 4");

    expect(prefix).toContain("section 4 (tip)");
  });

  it("falls back to yesterday snapshot when morning lacks the section", async () => {
    writeSnapshot("last-yesterday.json", {
      job: "yesterday-summary",
      fired_at: "2026-04-23T11:00:00Z",
      date_local: "2026-04-23",
      sections: [{ n: 1, module: "yesterday", content: "Yesterday summary" }],
    });

    const prefix = await buildDigestContextPrefix("more on 1");

    expect(prefix).toContain("yesterday-summary");
    expect(prefix).toContain("Yesterday summary");
  });

  it("returns empty string when section N doesn't exist in any snapshot", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [{ n: 1, module: "weather", content: "weather" }],
    });

    const prefix = await buildDigestContextPrefix("more on 9");

    expect(prefix).toBe("");
  });

  it("returns empty string when no snapshots exist", async () => {
    const prefix = await buildDigestContextPrefix("more on 3");
    expect(prefix).toBe("");
  });
});

describe("module-name drill-down", () => {
  it("'tell me about the news' finds news section", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [
        { n: 1, module: "weather", content: "Detroit 52F" },
        { n: 3, module: "news", content: "News bullets" },
      ],
    });

    const prefix = await buildDigestContextPrefix("tell me about the news");

    expect(prefix).toContain("news");
    expect(prefix).toContain("News bullets");
  });

  it("'more on weather' works", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [{ n: 1, module: "weather", content: "Weather data" }],
    });

    const prefix = await buildDigestContextPrefix("more on weather");

    expect(prefix).toContain("weather");
    expect(prefix).toContain("Weather data");
  });

  it("'focus' alias maps to 'today'", async () => {
    writeSnapshot("last-morning.json", {
      job: "morning-digest",
      fired_at: "2026-04-23T12:00:00Z",
      date_local: "2026-04-23",
      sections: [{ n: 2, module: "today", content: "Today items" }],
    });

    const prefix = await buildDigestContextPrefix("more on focus");

    expect(prefix).toContain("today");
    expect(prefix).toContain("Today items");
  });
});

describe("subject lookup", () => {
  it("'where did we leave off on <subject>' spawns subject-search and injects", async () => {
    mockExecFile.mockImplementation(((...args: any[]) => {
      const callback = args[args.length - 1];
      // Node-style callback (err, {stdout, stderr})
      callback(null, { stdout: "Hub-365 summary from script\n", stderr: "" });
      return {} as any;
    }) as any);

    const prefix = await buildDigestContextPrefix(
      "where did we leave off on Hub-365",
    );

    expect(prefix).toContain("[Subject context: Hub-365]");
    expect(prefix).toContain("Hub-365 summary from script");
    expect(prefix.endsWith("\n\n")).toBe(true);
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("subject-search timeout/error → returns empty (bot falls through)", async () => {
    mockExecFile.mockImplementation(((...args: any[]) => {
      const callback = args[args.length - 1];
      const err: any = new Error("timeout");
      err.killed = true;
      callback(err, { stdout: "", stderr: "" });
      return {} as any;
    }) as any);

    const prefix = await buildDigestContextPrefix(
      "where did we leave off on anything",
    );

    expect(prefix).toBe("");
  });

  it("empty subject does not spawn subject-search", async () => {
    const prefix = await buildDigestContextPrefix("where did we leave off on ");
    expect(prefix).toBe("");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("non-drill-down messages", () => {
  it("normal chat returns empty prefix", async () => {
    const prefix = await buildDigestContextPrefix(
      "hey what's the weather looking like in New York?",
    );
    expect(prefix).toBe("");
  });

  it("whitespace-only returns empty prefix", async () => {
    const prefix = await buildDigestContextPrefix("   ");
    expect(prefix).toBe("");
  });

  it("empty string returns empty prefix", async () => {
    const prefix = await buildDigestContextPrefix("");
    expect(prefix).toBe("");
  });
});

describe("malformed snapshot", () => {
  it("unreadable JSON returns empty prefix, no throw", async () => {
    writeFileSync(join(fixtureDir, "last-morning.json"), "{ not valid json");

    const prefix = await buildDigestContextPrefix("more on 3");

    expect(prefix).toBe("");
  });

  it("missing sections field returns empty prefix, no throw", async () => {
    writeSnapshot("last-morning.json", { job: "morning-digest" });

    const prefix = await buildDigestContextPrefix("more on 3");

    expect(prefix).toBe("");
  });
});
