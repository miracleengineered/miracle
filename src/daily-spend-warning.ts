/**
 * Daily-invocation soft warning for the main miracle bot.
 *
 * Background: miracle/bot runs on the operator's Claude Code subscription
 * (ANTHROPIC_API_KEY explicitly stripped before spawning `claude -p`).
 * No per-call billing, but a runaway loop could hammer the subscription
 * tier or signal a stuck handler. AskMiracle has a per-plan budget cap;
 * the main bot has nothing.
 *
 * This module tracks daily invocation count in a tiny JSON file and emits
 * a Telegram warning to the operator when the count crosses a threshold.
 * Soft warning only — never blocks an invocation. Count auto-resets each day.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";

const STATE_FILE =
  process.env.MIRACLE_DAILY_INVOCATIONS_FILE ?? `${homedir()}/.miracle/daily-invocations.json`;

const THRESHOLD = parseInt(process.env.MIRACLE_DAILY_INVOCATION_WARN_THRESHOLD ?? "200", 10);

interface DailyState {
  date: string;
  count: number;
  warned: boolean;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function readState(): DailyState {
  const today = todayStr();
  if (!existsSync(STATE_FILE)) {
    return { date: today, count: 0, warned: false };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as DailyState;
    if (parsed.date !== today) {
      return { date: today, count: 0, warned: false };
    }
    return parsed;
  } catch {
    return { date: today, count: 0, warned: false };
  }
}

function writeState(state: DailyState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch {
    // Non-fatal; warning system shouldn't break the bot.
  }
}

/**
 * Increment the day's invocation counter.
 * Returns the new count and whether the threshold was just crossed
 * (i.e., warning should fire). Caller is responsible for actually
 * sending the Telegram message.
 */
export function recordInvocation(): {
  count: number;
  shouldWarn: boolean;
  threshold: number;
} {
  const state = readState();
  state.count += 1;
  const shouldWarn = state.count >= THRESHOLD && !state.warned;
  if (shouldWarn) {
    state.warned = true;
  }
  writeState(state);
  return { count: state.count, shouldWarn, threshold: THRESHOLD };
}
