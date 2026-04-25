/**
 * Claude Telegram Bot - Node.js Edition
 *
 * Control Claude Code from your phone via Telegram.
 * Adapted from linuz90/claude-telegram-bot (Bun/TypeScript).
 */

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED-REJECTION]", reason);
  // Don't exit — let launchd KeepAlive handle crashes; stderr is the signal.
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT-EXCEPTION]", err);
  // Exit cleanly so launchd restart is deterministic.
  setTimeout(() => process.exit(1), 100);
});

import { Bot, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize } from "@grammyjs/runner";
import {
  TELEGRAM_TOKEN,
  ALLOWED_USERS,
  RESTART_FILE,
  CLAUDE_CLI_PATH,
  WORKING_DIR,
} from "./config";
import { loadEnv } from "./config/env";
import type { Tier3Runtime } from "./tier3/runtime";
import type { StartWorker } from "./orchestrator/types";
import { environmentForClaudeChild } from "./secrets";
import { isAuthorized, rateLimiter } from "./security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "./utils";
import { session } from "./session";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleSearch,
  handleProject,
  handleGsd,
  handleVoiceToggle,
  handleText,
  handleVoice,
  handleVoiceTier3,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
  sendTier3Reply,
  cleanupStreamingState,
  runTier3JobWithRetry,
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
  }),
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("help", handleStart);
bot.command("new", handleNew);
bot.command("clear", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("search", handleSearch);
bot.command("project", handleProject);
bot.command("gsd", handleGsd);
bot.command("voice", handleVoiceToggle);

// Miracle v1 slice — opt-in via MIRACLE_SLICE_ENABLED=true. When false
// (default), none of these commands register and no slice modules run.
// When true, the secrets loader already asserted ANTHROPIC_API_KEY_SLICE
// and MIRACLE_SLICE_CHAT_ID are present, and MIRACLE_HMAC_SECRET is
// required at callback time.
const miracleSliceEnabled = process.env.MIRACLE_SLICE_ENABLED === "true";
if (miracleSliceEnabled) {
  const { handlePlanCommand, handleMiracleHalt, handleMiracleStatus, handleMiracleCancel } =
    await import("./handlers/miracle-commands");
  bot.command("plan", handlePlanCommand);
  bot.command("miracle_halt", handleMiracleHalt);
  bot.command("miracle_status", handleMiracleStatus);
  bot.command("miracle_cancel", handleMiracleCancel);
}

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
    // Startup recovery (Fix 3.D): sweep any job left as `running` from a prior
    // launch — orchestrator or leaf, any kind — into `failed` so we don't
    // accumulate ghost jobs. 10-minute threshold keeps legitimately-running
    // jobs alive across a quick bot restart.
    if (notebook.recoverStaleRunning) {
      const stale = notebook.recoverStaleRunning(10 * 60 * 1000);
      if (stale > 0) {
        console.log(`startup: reset ${stale} stale running job(s) to failed`);
      }
    }
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
    const typing = startTypingIndicator(ctx);
    try {
      const { result, state, contextRef } = await runTier3JobWithRetry({
        ctx,
        runtime,
        ask: message,
        startWorker,
        conversationSessionId: session.sessionId,
        onCrashRetry: async () => {
          await ctx.reply("⚠️ Claude crashed, retrying...");
        },
      });
      if (result.conversationSessionId && result.conversationSessionId !== session.sessionId) {
        session.sessionId = result.conversationSessionId;
        session.saveSession();
      }
      await sendTier3Reply(ctx, result, {
        contextPercent: contextRef.percent,
        streamingState: state,
      });
      if (session.voiceMode) {
        const { textToSpeech } = await import("./utils");
        const audio = await textToSpeech(result.output || "");
        if (audio) {
          await ctx.replyWithVoice(new InputFile(audio, "response.ogg"));
        }
      }
      await auditLog(userId, username, "TEXT", message, result.output);
    } catch (err) {
      console.error("Tier 3 runJob failed:", err);
      await ctx.reply("Something went wrong.");
      await auditLog(userId, username, "TEXT", message, "[tier3 runJob failed]");
    } finally {
      typing.stop();
    }
  });
  bot.on("message:voice", (ctx) => handleVoiceTier3(ctx, runtime, startWorker));
} else {
  bot.on("message:text", handleText);
  bot.on("message:voice", handleVoice);
}
bot.on("message:photo", handlePhoto);
bot.on("message:document", handleDocument);
bot.on("message:audio", handleAudio);
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

if (miracleSliceEnabled) {
  const { handleMiracleCallback, isMiracleCallback } = await import("./handlers/miracle-callback");
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data && isMiracleCallback(data)) {
      await handleMiracleCallback(ctx);
      return;
    }
    await next();
  });
}
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

const baseCommands = [
  { command: "start", description: "Show status + commands" },
  { command: "help", description: "Show status + commands" },
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
];
const sliceCommands = miracleSliceEnabled
  ? [
      { command: "plan", description: "Propose a plan for approval (Miracle slice)" },
      { command: "miracle_halt", description: "Stop the running Miracle plan" },
      { command: "miracle_status", description: "List pending + running Miracle plans" },
      { command: "miracle_cancel", description: "Cancel a pending Miracle plan by id prefix" },
    ]
  : [];
await bot.api.setMyCommands([...baseCommands, ...sliceCommands]);
console.log("Command menu registered");

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(data.chat_id, data.message_id, "✅ Bot restarted");
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try {
      unlinkSync(RESTART_FILE);
    } catch (cleanupErr) {
      // RESTART_FILE is best-effort cleanup; a stat failure here is expected
      // if the file was already removed by another path. Log at debug level.
      console.debug("RESTART_FILE cleanup skipped:", cleanupErr);
    }
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
  // Mark any Miracle slice plans that were `running` as `failed_shutdown`
  // so they don't reappear as ghost jobs after restart (Fix 3.K).
  if (miracleSliceEnabled) {
    try {
      const { markRunningPlansAsShutdown } = await import("./miracle/db");
      const changed = markRunningPlansAsShutdown();
      if (changed > 0) {
        console.log(`shutdown: marked ${changed} running miracle plan(s) as failed_shutdown`);
      }
    } catch (err) {
      console.error("shutdown: markRunningPlansAsShutdown failed:", err);
    }
  }
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
