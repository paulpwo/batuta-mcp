/**
 * The only module that reads `process.env`. It exposes an explicit allowlist, so the set of
 * environment variables the server honours is visible in one place (and checked by a test).
 */

export const ALLOWED_ENV_VARS = [
  "HOME",
  "BATUTA_CONFIG",
  "BATUTA_EDITION",
  "BATUTA_DESTRUCTIVE",
  "BATUTA_CONFIRM",
  "BATUTA_MAX_JUMP_DB",
  "BATUTA_MAX_MASTER_DB",
  "BATUTA_LOG_LEVEL",
] as const;

export type EnvSnapshot = Partial<Record<(typeof ALLOWED_ENV_VARS)[number], string>>;

/** Copy only the allowlisted variables that are set. */
export function snapshotEnv(): EnvSnapshot {
  const env = process.env;
  // One literal read per variable: no computed access, so the set of names is exactly this list.
  const reads: Array<[(typeof ALLOWED_ENV_VARS)[number], string | undefined]> = [
    ["HOME", env["HOME"]],
    ["BATUTA_CONFIG", env["BATUTA_CONFIG"]],
    ["BATUTA_EDITION", env["BATUTA_EDITION"]],
    ["BATUTA_DESTRUCTIVE", env["BATUTA_DESTRUCTIVE"]],
    ["BATUTA_CONFIRM", env["BATUTA_CONFIRM"]],
    ["BATUTA_MAX_JUMP_DB", env["BATUTA_MAX_JUMP_DB"]],
    ["BATUTA_MAX_MASTER_DB", env["BATUTA_MAX_MASTER_DB"]],
    ["BATUTA_LOG_LEVEL", env["BATUTA_LOG_LEVEL"]],
  ];
  return Object.fromEntries(reads.filter(([, value]) => value !== undefined)) as EnvSnapshot;
}
