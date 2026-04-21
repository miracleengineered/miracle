/**
 * Claude Telegram Bot - Node.js Edition
 *
 * Control Claude Code from your phone via Telegram.
 * Adapted from linuz90/claude-telegram-bot (Bun/TypeScript).
 */

import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, ALLOWED_USERS, RESTART_FILE, CLAUDE_CLI_PATH, WORKING_DIR } from "./config";
import { loadEnv } from "./config/env";
import type { Tier3Runtime } from "./tier3/runtime";
import type { StartWorker } from "./orchestrator/types";
import { environmentForClaudeChild } from "./secrets";
import { isAuthorized, rateLimiter } from "./security";
import { auditLog, auditLogRateLimit } from "./utils";
import { session } from "./session";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleClear,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleSearch,
  handleProject,
  handleGsd,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Auto-retry outbound API calls on rate limits and server errors
bot.api.config.use(autoRetry());

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("clear", handleClear);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("search", handleSearch);
bot.command("project", handleProject);
bot.command("gsd", handleGsd);

// ============== Message Handlers ==============

// Tier 3 runtime: opt-in via TIER_3_ENABLED=true. When disabled (default),
// no new modules load, no listener binds, no DB opens — MVP behavior is
// byte-identical to today. When enabled, text messages route through
// runtime.runJob() instead of session.sendMessageStreaming().
const tier3Env = loadEnv();
let tier3Runtime: Tier3Runtime | null = null;
let tier3StartWorker: StartWorker | null = null;
if (tier3Env.tier3Enabled) {
  try {
    const { SqliteNotebookClient } = await import("./notebook/client");
    const { createTier3Runtime } = await import("./tier3/runtime");
    const { createClaudeWorker } = await import("./tier3/workers/claudeWorker");
    const notebook = new SqliteNotebookClient({ dbPath: tier3Env.miracleDbPath });
    tier3Runtime = createTier3Runtime({ notebook, host: "127.0.0.1", port: 8787 });
    tier3StartWorker = createClaudeWorker({
      client: notebook,
      correlator: tier3Runtime.correlator,
      claudeCliPath: CLAUDE_CLI_PATH,
      workingDir: WORKING_DIR,
      env: environmentForClaudeChild(),
    });
    await tier3Runtime.listener.start();
  } catch (err) {
    console.error("Tier 3 startup failed:", err);
    process.exit(1);
  }
}

if (tier3Runtime) {
  const runtime = tier3Runtime;
  const startWorker = tier3StartWorker!;
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const username = ctx.from?.username || "unknown";
    const message = ctx.message?.text;
    if (!userId || !message || !ctx.chat?.id) return;
    if (!isAuthorized(userId, ALLOWED_USERS)) {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
      return;
    }
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }
    await ctx.replyWithChatAction("typing");
    try {
      const result = await runtime.runJob(message, { startWorker });
      await ctx.reply(result.output || "(no output)");
      await auditLog(userId, username, "TEXT", message, result.output);
    } catch (err) {
      console.error("Tier 3 runJob failed:", err);
      await ctx.reply("Something went wrong.");
      await auditLog(userId, username, "TEXT", message, "[tier3 runJob failed]");
    }
  });
} else {
  bot.on("message:text", handleText);
}
bot.on("message:voice", handleVoice);
bot.on("message:photo", handlePhoto);
bot.on("message:document", handleDocument);
bot.on("message:audio", handleAudio);
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - Node.js Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${session.currentWorkingDir}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info and register command menu
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

await bot.api.setMyCommands([
  { command: "new", description: "Start a new conversation" },
  { command: "clear", description: "Clear context and start fresh" },
  { command: "stop", description: "Stop current query" },
  { command: "status", description: "Show session status" },
  { command: "resume", description: "Resume a saved session" },
  { command: "project", description: "Switch working directory" },
  { command: "gsd", description: "GSD workflow operations" },
  { command: "retry", description: "Retry last message" },
  { command: "search", description: "Search the vault" },
  { command: "restart", description: "Restart the bot process" },
]);
console.log("Command menu registered");

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const stopRunner = async () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
  if (tier3Runtime) await tier3Runtime.stop();
};

process.on("SIGINT", async () => {
  console.log("Received SIGINT");
  await stopRunner();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM");
  await stopRunner();
  process.exit(0);
});
