import { describe, it, expect } from "vitest";
import { escapeHtml, convertMarkdownToHtml, formatToolStatus } from "../src/formatting";

// ============== escapeHtml ==============

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes all special chars in one string", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

// ============== convertMarkdownToHtml ==============

describe("convertMarkdownToHtml", () => {
  it("converts **bold** to <b>", () => {
    expect(convertMarkdownToHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts *italic-as-bold* to <b> (Telegram convention)", () => {
    expect(convertMarkdownToHtml("*hello*")).toBe("<b>hello</b>");
  });

  it("converts _italic_ to <i>", () => {
    expect(convertMarkdownToHtml("_hello_")).toBe("<i>hello</i>");
  });

  it("converts ## headers to bold with newline", () => {
    expect(convertMarkdownToHtml("## Title")).toBe("<b>Title</b>\n");
  });

  it("converts code blocks to <pre>", () => {
    const input = "```js\nconsole.log(1)\n```";
    expect(convertMarkdownToHtml(input)).toContain("<pre>console.log(1)\n</pre>");
  });

  it("converts inline code to <code>", () => {
    expect(convertMarkdownToHtml("use `foo` here")).toBe("use <code>foo</code> here");
  });

  it("converts links to <a> tags", () => {
    expect(convertMarkdownToHtml("[text](https://example.com)")).toBe(
      '<a href="https://example.com">text</a>',
    );
  });

  it("converts blockquotes to <blockquote>", () => {
    expect(convertMarkdownToHtml("> quoted text")).toBe("<blockquote>quoted text</blockquote>");
  });

  it("converts bullet lists with - to bullet dots", () => {
    expect(convertMarkdownToHtml("- item one\n- item two")).toBe("• item one\n• item two");
  });

  it("converts horizontal rules to empty string", () => {
    expect(convertMarkdownToHtml("---")).toBe("");
  });

  it("returns empty string unchanged", () => {
    expect(convertMarkdownToHtml("")).toBe("");
  });

  it("collapses 3+ newlines to 2", () => {
    expect(convertMarkdownToHtml("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("escapes HTML inside text but not inside code blocks", () => {
    const input = "use <div> outside\n```\n<div>inside</div>\n```";
    const result = convertMarkdownToHtml(input);
    expect(result).toContain("&lt;div&gt; outside");
    expect(result).toContain("<pre>&lt;div&gt;inside&lt;/div&gt;\n</pre>");
  });
});

// ============== formatToolStatus ==============

describe("formatToolStatus", () => {
  it("formats Read with shortened path", () => {
    const result = formatToolStatus("Read", {
      file_path: "/home/user/projects/app/src/index.ts",
    });
    expect(result).toContain("📖");
    expect(result).toContain("src/index.ts");
  });

  it("detects image files and returns 'Viewing'", () => {
    const result = formatToolStatus("Read", { file_path: "photo.png" });
    expect(result).toBe("👀 Viewing");
  });

  it("detects jpg images case-insensitively", () => {
    expect(formatToolStatus("Read", { file_path: "img.JPG" })).toBe("👀 Viewing");
  });

  it("formats Write with shortened path", () => {
    const result = formatToolStatus("Write", {
      file_path: "/a/b/c/output.txt",
    });
    expect(result).toContain("📝");
    expect(result).toContain("c/output.txt");
  });

  it("formats Edit with shortened path", () => {
    const result = formatToolStatus("Edit", { file_path: "/x/y/z.ts" });
    expect(result).toContain("✏️");
    expect(result).toContain("y/z.ts");
  });

  it("formats Bash with description when present", () => {
    const result = formatToolStatus("Bash", {
      command: "npm install",
      description: "Install dependencies",
    });
    expect(result).toContain("▶️");
    expect(result).toContain("Install dependencies");
    expect(result).not.toContain("npm install");
  });

  it("formats Bash with command when no description", () => {
    const result = formatToolStatus("Bash", { command: "git status" });
    expect(result).toContain("▶️");
    expect(result).toContain("git status");
  });

  it("formats Grep with pattern and path", () => {
    const result = formatToolStatus("Grep", {
      pattern: "TODO",
      path: "/home/user/project/src",
    });
    expect(result).toContain("🔎");
    expect(result).toContain("TODO");
    expect(result).toContain("project/src");
  });

  it("formats Glob with pattern", () => {
    const result = formatToolStatus("Glob", { pattern: "**/*.ts" });
    expect(result).toContain("🔍");
    expect(result).toContain("**/*.ts");
  });

  it("formats WebSearch with query", () => {
    const result = formatToolStatus("WebSearch", { query: "vitest docs" });
    expect(result).toContain("🔍");
    expect(result).toContain("vitest docs");
  });

  it("formats WebFetch with URL", () => {
    const result = formatToolStatus("WebFetch", {
      url: "https://example.com/api",
    });
    expect(result).toContain("🌐");
    expect(result).toContain("example.com/api");
  });

  it("formats Task with description", () => {
    const result = formatToolStatus("Task", { description: "research APIs" });
    expect(result).toContain("🎯");
    expect(result).toContain("research APIs");
  });

  it("formats Task without description", () => {
    const result = formatToolStatus("Task", {});
    expect(result).toBe("🎯 Running agent...");
  });

  it("formats Skill with name", () => {
    const result = formatToolStatus("Skill", { skill: "commit" });
    expect(result).toContain("💭");
    expect(result).toContain("commit");
  });

  it("formats MCP tools with server and action", () => {
    const result = formatToolStatus("mcp__playwright__browser_click", {});
    expect(result).toContain("🔧");
    expect(result).toContain("playwright");
    expect(result).toContain("browser click");
  });

  it("formats MCP tools with summary from input", () => {
    const result = formatToolStatus("mcp__db__query", {
      query: "SELECT * FROM users",
    });
    expect(result).toContain("db");
    expect(result).toContain("SELECT * FROM users");
  });

  it("escapes HTML in Bash description", () => {
    const result = formatToolStatus("Bash", {
      command: "echo test",
      description: "Run <script> test",
    });
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("truncates long paths in Read", () => {
    const result = formatToolStatus("Read", {
      file_path: "/a/b/c/d/e/very-long-filename.ts",
    });
    // Should show last 2 components
    expect(result).toContain("e/very-long-filename.ts");
    expect(result).not.toContain("/a/b/c/d/");
  });

  it("falls back to wrench emoji for unknown tools", () => {
    const result = formatToolStatus("UnknownTool", {});
    expect(result).toContain("🔧");
    expect(result).toContain("UnknownTool");
  });
});
