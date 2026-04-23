/**
 * Swap process.env.ANTHROPIC_API_KEY to the slice-scoped workspace key
 * for the duration of an SDK call, then restore. Required because the
 * @anthropic-ai/claude-agent-sdk reads ANTHROPIC_API_KEY from env (or
 * falls back to Claude Max subscription OAuth — which would bill the
 * wrong account).
 *
 * Why swap rather than set once: the Miracle MVP path relies on the
 * claude CLI using subscription auth, which happens precisely because
 * ANTHROPIC_API_KEY is absent from the bot's env. Setting it persistently
 * would flip the CLI side to API-key billing too. By swapping for the
 * in-process SDK call window only — and restoring afterward — both auth
 * modes coexist safely. CLI children also strip the key via
 * environmentForClaudeChild as defense-in-depth.
 *
 * Concurrency: Miracle enforces max 1 concurrent plan (decision #18),
 * so sequential SDK calls mean no env-swap races.
 */

export async function withSliceApiKey<T>(fn: () => Promise<T>): Promise<T> {
  const sliceKey = process.env.ANTHROPIC_API_KEY_SLICE;
  if (!sliceKey) {
    throw new Error(
      "MIRACLE slice: ANTHROPIC_API_KEY_SLICE not present in env. " +
        "Check MIRACLE_SLICE_ENABLED=true and the keychain entry " +
        "miracle-slice-ANTHROPIC_API_KEY.",
    );
  }

  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = sliceKey;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = prev;
    }
  }
}
