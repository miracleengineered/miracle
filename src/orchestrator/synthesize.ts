import type { SubtaskResult } from "./types.js";

function formatResult(result: unknown): string {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed || "No result provided.";
  }

  if (result == null) {
    return "No result provided.";
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function synthesizeResults(subtasks: readonly SubtaskResult[]): string {
  return [...subtasks]
    .sort((left, right) => left.index - right.index)
    .map((subtask) => {
      const header = `## Subtask ${subtask.index + 1}: ${subtask.ask}`;
      const status = `Status: ${subtask.status}`;
      const body = formatResult(subtask.result);
      return [header, status, "", body].join("\n");
    })
    .join("\n\n");
}
