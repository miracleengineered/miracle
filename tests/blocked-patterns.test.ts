import { describe, it, expect } from "vitest";
import { BLOCKED_PATTERNS } from "../src/config";

describe("BLOCKED_PATTERNS expansion (Fix 3.C)", () => {
  const required = [
    // git force/destructive
    "git reset --hard",
    "git push --force",
    "git push -f",
    // filesystem destructive variants
    "rm -rf ./",
    "rm -rf *",
    "chmod -R 000",
    "chown -R",
    // credential exfil
    "gh auth token",
    "security find-generic-password",
    "security delete-generic-password",
    // infra sabotage
    "launchctl bootout gui/",
    "killall -9",
  ];

  it.each(required)("contains %s", (pattern) => {
    expect(BLOCKED_PATTERNS).toContain(pattern);
  });

  it("preserves original patterns", () => {
    for (const p of ["rm -rf /", "sudo rm", "dd if=", "mkfs."]) {
      expect(BLOCKED_PATTERNS).toContain(p);
    }
  });
});
