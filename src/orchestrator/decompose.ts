import type { DecomposedSubtask } from "./types.js";

function cleanSegment(segment: string): string {
  return segment.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "").trim();
}

function extractNumberedList(ask: string): string[] {
  const matches = [...ask.matchAll(/(?:^|\n)\s*\d+[.)]\s+([\s\S]*?)(?=(?:\n\s*\d+[.)]\s+)|$)/g)];

  return matches.map((match) => cleanSegment(match[1] ?? "")).filter(Boolean);
}

export function decomposeAsk(ask: string): DecomposedSubtask[] {
  const normalizedAsk = ask.replace(/\r\n/g, "\n").trim();
  if (!normalizedAsk) {
    return [{ index: 0, ask: "" }];
  }

  const numberedItems = extractNumberedList(normalizedAsk);
  if (numberedItems.length >= 2) {
    return numberedItems.map((item, index) => ({ index, ask: item }));
  }

  return [{ index: 0, ask: cleanSegment(normalizedAsk) }];
}
