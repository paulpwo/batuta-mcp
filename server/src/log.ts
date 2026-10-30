/**
 * Logging for the server process.
 *
 * Everything goes to stderr: stdout belongs to the MCP JSON-RPC stream and must never carry anything
 * else. The logger redacts registered secrets (the Remote Script token) and strips control characters
 * so that untrusted text cannot forge extra log lines.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

function levelRank(level: LogLevel): number {
  switch (level) {
    case "debug": return 0;
    case "info": return 1;
    case "warn": return 2;
    case "error": return 3;
  }
}
/** Secrets shorter than this are not redacted (they would mangle ordinary text). */
const MIN_SECRET_LENGTH = 8;

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Register a value that must never appear in a log line. */
  addSecret(secret: string): void;
}

export interface LoggerOptions {
  /** Receives one finished line without trailing newline. Defaults to stderr. */
  sink?: (line: string) => void;
  level?: LogLevel;
  secrets?: string[];
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Parse `BATUTA_LOG_LEVEL`: unset means info; anything that is not a level name is an error. */
export function parseLogLevel(text: string | undefined): LogLevel {
  if (text === undefined) return "info";
  if (text === "debug" || text === "info" || text === "warn" || text === "error") return text;
  throw new Error(`BATUTA_LOG_LEVEL must be one of debug, info, warn, error (got "${text.slice(0, 20)}")`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const threshold = levelRank(options.level ?? "info");
  const secrets = new Set<string>();
  const addSecret = (secret: string): void => {
    if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
  };
  for (const secret of options.secrets ?? []) addSecret(secret);

  const emit = (level: LogLevel, message: string): void => {
    if (levelRank(level) < threshold) return;
    let text = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    for (const secret of secrets) text = text.split(secret).join("<redacted>");
    try {
      sink(`batuta-mcp [${level}] ${text}`);
    } catch {
      // A failing log sink must never take the server down.
    }
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    addSecret,
  };
}
