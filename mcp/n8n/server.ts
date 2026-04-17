/**
 * Miracle — n8n webhook adapter MCP server.
 *
 * Exposes exactly one tool, `call_n8n_webhook(url, payload)`. Generic over any
 * n8n workflow webhook URL — adapter pattern only. No workflow-specific logic,
 * no hardcoded URLs, no embedded auth tokens. Runs as a stdio MCP server under
 * Claude Code's MCP discovery (registered via mcp-config.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 20_000;

const server = new McpServer({
  name: "miracle-n8n-adapter",
  version: "0.1.0",
});

server.registerTool(
  "call_n8n_webhook",
  {
    title: "Call n8n webhook",
    description:
      "POST a JSON payload to an n8n webhook URL and return the response. " +
      "Use when Miracle needs to trigger an n8n workflow. The caller supplies " +
      "the full webhook URL and the payload shape required by that workflow.",
    inputSchema: {
      url: z
        .string()
        .url()
        .refine(
          (u) => u.startsWith("http://") || u.startsWith("https://"),
          "URL must use http:// or https:// scheme",
        )
        .describe("Full n8n webhook URL."),
      payload: z
        .record(z.string(), z.unknown())
        .describe("JSON-serializable object sent as the POST body."),
    },
  },
  async ({ url, payload }) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text", text: `n8n request failed: ${reason}` }],
        isError: true,
      };
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `n8n returned HTTP ${response.status} ${response.statusText}.\n` +
              `Body: ${bodyText}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: `HTTP ${response.status}\n${bodyText}` },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
