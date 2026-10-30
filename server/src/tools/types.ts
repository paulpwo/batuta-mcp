import type { Schema } from "../validate/index.js";

/** Destructive classification of a command (docs/01-protocol.md section 9.1), ordered by strictness. */
export type Classification = "never" | "always" | "conditional";

/**
 * Where a tool argument holds a selector that the server resolves to a wire reference
 * (section 6.1 and 7.16): every kind accepts either the wire shape or a name selector.
 */
export type RefKind =
  | "track" | "trackOnly" | "scene" | "device" | "container" | "param" | "clip" | "slotref"
  | "trackList" | "trackOnlyList" | "paramItems";

/**
 * Compatibility argument names that a broad tool also accepts (docs/03-tool-names.md).
 * They are mapped onto the broad arguments before anything else happens, so every guard sees the
 * same call; the wire never carries a compat argument.
 */
export interface CompatSpec {
  /** Published next to the broad properties (all optional in the schema). */
  properties: Record<string, Schema>;
  /** Broad required arguments the compat form can supply (they leave the published `required`). */
  supplies: string[];
  /** Compat arguments that must be given together once any of them is. */
  together?: string[];
  /** Broad arguments built from the compat values given (keys are compat property names). */
  build: (given: Record<string, unknown>) => Record<string, unknown>;
}

/** One MCP tool backed by one Remote Script command. */
export interface CommandSpec {
  /** Wire command name; the broad tool is called PUBLIC_NAMES[command] (names.ts). */
  command: string;
  /** Imperative label used in confirmation summaries, e.g. "Delete track". Static text only. */
  summary: string;
  /** Written for a model: what it does, units, destructive behavior, Lite limits. */
  description: string;
  mutating: boolean;
  destructive: Classification;
  /** Arguments that decide whether a conditional command is destructive (as in the script catalog). */
  conditions: string[];
  /** Pure setter: repeating the call with the same arguments changes nothing more. */
  idempotent?: boolean;
  properties: Record<string, Schema>;
  required?: string[];
  /** Argument pairs the script refuses to receive together. */
  exclusive?: Array<[string, string]>;
  atLeastOne?: boolean;
  /** Top-level arguments that carry selectors. */
  refs?: Record<string, RefKind>;
  /** For conditional commands: the reason the call is destructive, or null (evaluated on the wire arguments). */
  condition?: (args: Record<string, unknown>) => string | null;
  /** Compatibility argument names. */
  compat?: CompatSpec;
}
