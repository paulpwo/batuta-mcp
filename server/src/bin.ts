#!/usr/bin/env -S node --disallow-code-generation-from-strings
// The shebang above is part of the security model: it makes V8 throw EvalError for eval() and
// Function(), a runtime backstop behind the static checks. It only applies when this file is
// executed directly, so MCP client configs must launch the `batuta-mcp` binary itself, never
// `node dist/src/bin.js` (which would run without the flag).
import os from "node:os";
import { ConfigError, loadConfig } from "./config/index.js";
import { snapshotEnv } from "./env.js";
import { LiveClient, defaultRuntimeDir } from "./live/index.js";
import { createLogger, parseLogLevel } from "./log.js";
import { McpServer, ToolRegistry, stdioStreams } from "./mcp/index.js";
import { BATUTA_INSTRUCTIONS } from "./instructions.js";
import { registerBatutaTools } from "./tools/index.js";
import { MIN_SCRIPT_VERSION, VERSION } from "./version.js";

/** Hard stop if something keeps the event loop alive after a clean shutdown. */
const EXIT_BACKSTOP_MS = 3000;

async function main(): Promise<void> {
  const env = snapshotEnv();
  let level;
  try {
    level = parseLogLevel(env.BATUTA_LOG_LEVEL);
  } catch (error) {
    createLogger().error((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const logger = createLogger({ level });

  let loaded;
  try {
    loaded = loadConfig({ env });
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(`invalid configuration: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const { config } = loaded;
  logger.info(`batuta-mcp ${VERSION} starting (config: ${loaded.source}, destructive: ${config.destructive})`);

  const live = new LiveClient({
    runtimeDir: defaultRuntimeDir(env.HOME ?? os.homedir()),
    flags: {
      allowPlugins: config.browser.allowPlugins,
      allowUserPresets: config.browser.allowUserPresets,
      allowMaxForLive: config.browser.allowMaxForLive,
      allowExternalDevices: config.browser.allowExternalDevices,
      allowAudioImport: config.allowAudioImport,
    },
    clientName: `batuta-mcp/${VERSION}`,
    ...(config.edition === "auto" ? {} : { editionHint: config.edition }),
    minScriptVersion: MIN_SCRIPT_VERSION,
    logger,
    // One Claude session holds Live's single slot; the others are refused until it is released.
    onDemand: true,
    idleReleaseMs: config.live.idleReleaseS * 1000,
  });

  const registry = new ToolRegistry();
  registerBatutaTools(registry, { live, config, logger });
  // No live.start(): the client connects on the first tool call that needs Live (session ownership).

  const { input, output } = stdioStreams();
  const server = new McpServer({
    input, output, registry, logger,
    serverInfo: { name: "batuta-mcp", title: "BatutaMCP", version: VERSION },
    instructions: BATUTA_INSTRUCTIONS,
  });
  const stop = (): void => { void server.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await server.run();
  await live.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), EXIT_BACKSTOP_MS).unref();
}

main().catch((error: unknown) => {
  createLogger().error(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
