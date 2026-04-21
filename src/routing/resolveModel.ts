// Phase 3 / C6 model routing. See INTERFACES.md → "Phase 3 contracts"
// for the authoritative contract.
//
// The routing table lives at src/routing/routing-table.json (version-
// controlled, editable without code changes). This module loads the
// table once at import time. The pre-kickoff commit ships an empty
// table; the C6 sub-branch populates it after auditing real orchestrator
// call sites.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelName, RoutingTable } from "../types/phase3.js";

export type { ModelName, ModelRoute, RoutingTable } from "../types/phase3.js";

const tablePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "routing-table.json",
);

const table: RoutingTable = JSON.parse(readFileSync(tablePath, "utf8")) as RoutingTable;

export function resolveModel(kind: string, override?: ModelName): ModelName {
  if (override) return override;
  const route = table[kind];
  if (!route) throw new Error(`unknown kind: ${kind}`);
  return route.default;
}
