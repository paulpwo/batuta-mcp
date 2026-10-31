import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, defaultConfig, ConfigError, parseConfig } from "../src/config/index.js";

function makeDir(): string {
  return fs.mkdtempSync("/tmp/bm-");
}
function write(dir: string, content: string, mode = 0o600): string {
  const file = path.join(dir, "server.json");
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}
function expectConfigError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof ConfigError && pattern.test(e.message), String(pattern));
}

test("defaults match Appendix B", () => {
  const c = defaultConfig();
  assert.equal(c.edition, "auto");
  assert.equal(c.destructive, "confirm");
  assert.equal(c.confirm, "irreversible");
  assert.equal(c.gainGuard.maxJumpDb, 6.0);
  assert.equal(c.gainGuard.maxMasterDb, 0.0);
  assert.equal(c.browser.allowPlugins, true, "installed VST/AU plugins load by default (owner decision 2026-10-30, zero config)");
  assert.equal(c.browser.allowMaxForLive, true, "Max for Live loads by default (owner decision 2026-10-30)");
  assert.equal(c.browser.allowExternalDevices, true, "External devices load by default");
  assert.equal(c.browser.allowUserPresets, true);
  assert.deepEqual(c.sampleRoots, []);
  assert.equal(c.ears.enabled, true);
  assert.equal(c.ears.maxBytes, 256 * 1024 * 1024);
  assert.equal(c.ears.maxBeats, 64);
  assert.deepEqual(c.ears.roots, []);
  assert.deepEqual(c.ears.setRoots, []);
  assert.equal(c.allowAudioImport, true, "audio import needs no configuration");
});

test("a missing config file at the default location yields defaults", () => {
  const dir = makeDir();
  try {
    const { config, source } = loadConfig({ env: {}, home: dir });
    assert.deepEqual(config, defaultConfig());
    assert.equal(source, "defaults");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a config path that was asked for explicitly (option or BATUTA_CONFIG) must exist", () => {
  const dir = makeDir();
  try {
    const missing = path.join(dir, "server.json");
    expectConfigError(() => loadConfig({ env: { BATUTA_CONFIG: missing } }), /does not exist/);
    expectConfigError(() => loadConfig({ configPath: missing, env: {} }), /does not exist/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a full valid file is parsed into the typed config", () => {
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({
      edition: "lite", destructive: "disabled",
      gain_guard: { max_jump_db: 3, max_master_db: -1.5 },
      browser: { allow_plugins: true, allow_user_presets: true, allow_max_for_live: false, allow_external_devices: false },
      sample_roots: ["/Users/me/Samples"],
      ears: { enabled: false, max_bytes: 1000, max_beats: 8, roots: ["/Users/me/Rec"], set_roots: ["/Users/me/Set"] },
    }));
    const { config, source } = loadConfig({ configPath: file, env: {} });
    assert.equal(source, file);
    assert.equal(config.edition, "lite");
    assert.equal(config.destructive, "disabled");
    assert.deepEqual(config.gainGuard, { maxJumpDb: 3, maxMasterDb: -1.5 });
    assert.deepEqual(config.browser, { allowPlugins: true, allowUserPresets: true, allowMaxForLive: false, allowExternalDevices: false });
    assert.deepEqual(config.sampleRoots, ["/Users/me/Samples"]);
    assert.equal(config.allowAudioImport, true, "sample_roots only narrows imports, it never gates them");
    assert.deepEqual(config.ears, { enabled: false, maxBytes: 1000, maxBeats: 8, roots: ["/Users/me/Rec"], setRoots: ["/Users/me/Set"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unknown keys are rejected at every level, naming the key", () => {
  expectConfigError(() => parseConfig({ edtion: "lite" }), /unknown key "edtion"/);
  expectConfigError(() => parseConfig({ gain_guard: { max_jump: 1 } }), /unknown key "gain_guard\.max_jump"/);
  expectConfigError(() => parseConfig({ browser: { allow_m4l: true } }), /unknown key "browser\.allow_m4l"/);
  expectConfigError(() => parseConfig({ ears: { nope: 1 } }), /unknown key "ears\.nope"/);
  expectConfigError(() => parseConfig({ min_script_version: "0.1.0" }), /unknown key "min_script_version"/);
});

test("values are validated by type, enum and range", () => {
  expectConfigError(() => parseConfig({ edition: "pro" }), /edition/);
  expectConfigError(() => parseConfig({ destructive: "yes" }), /destructive/);
  expectConfigError(() => parseConfig({ destructive: true }), /destructive/);
  expectConfigError(() => parseConfig({ gain_guard: { max_jump_db: "6" } }), /max_jump_db/);
  expectConfigError(() => parseConfig({ gain_guard: { max_jump_db: -1 } }), /max_jump_db/);
  expectConfigError(() => parseConfig({ gain_guard: { max_jump_db: 1000 } }), /max_jump_db/);
  expectConfigError(() => parseConfig({ gain_guard: { max_master_db: 7 } }), /max_master_db/);
  expectConfigError(() => parseConfig({ browser: { allow_plugins: "true" } }), /allow_plugins/);
  expectConfigError(() => parseConfig({ browser: { allow_max_for_live: "yes" } }), /allow_max_for_live/);
  expectConfigError(() => parseConfig({ browser: { allow_external_devices: 1 } }), /allow_external_devices/);
  expectConfigError(() => parseConfig({ sample_roots: "x" }), /sample_roots/);
  expectConfigError(() => parseConfig({ sample_roots: [1] }), /sample_roots/);
  expectConfigError(() => parseConfig({ sample_roots: ["relative/path"] }), /absolute/);
  expectConfigError(() => parseConfig({ sample_roots: ["/a/../b"] }), /\.\./);
  expectConfigError(() => parseConfig({ sample_roots: ["/a\u0000b"] }), /control/);
  expectConfigError(() => parseConfig({ sample_roots: ["/"] }), /filesystem root/);
  expectConfigError(() => parseConfig({ ears: { max_bytes: 2 * 1024 ** 3 } }), /max_bytes/);
  expectConfigError(() => parseConfig({ ears: { max_bytes: 0 } }), /max_bytes/);
  expectConfigError(() => parseConfig({ ears: { max_beats: 65 } }), /max_beats/);
  expectConfigError(() => parseConfig({ ears: { max_beats: 1.5 } }), /max_beats/);
  expectConfigError(() => parseConfig([]), /object/);
  expectConfigError(() => parseConfig(null), /object/);
  assert.doesNotThrow(() => parseConfig({ ears: { max_bytes: 1024 ** 3, max_beats: 64 } }));
  assert.doesNotThrow(() => parseConfig({}));
});

test("the file must be a regular 0600 file owned by the user; JSON must be valid", () => {
  const dir = makeDir();
  try {
    expectConfigError(() => loadConfig({ configPath: write(dir, "{}", 0o644), env: {} }), /mode 0600|group or others/);
    expectConfigError(() => loadConfig({ configPath: write(dir, "{}", 0o640), env: {} }), /group or others/);
    expectConfigError(() => loadConfig({ configPath: write(dir, "{nope"), env: {} }), /not valid JSON/);
    expectConfigError(() => loadConfig({ configPath: write(dir, '{"edition":"lite","edition":"suite"}'), env: {} }), /duplicate|not valid/i);
    expectConfigError(() => loadConfig({ configPath: write(dir, "{}"), env: {}, expectedUid: (process.getuid?.() ?? 0) + 1 }), /owned by/);
    const target = write(dir, "{}");
    const link = path.join(dir, "link.json");
    fs.symlinkSync(target, link);
    expectConfigError(() => loadConfig({ configPath: link, env: {} }), /symlink|regular file/);
    fs.chmodSync(dir, 0o777);
    expectConfigError(() => loadConfig({ configPath: target, env: {} }), /directory/);
    fs.chmodSync(dir, 0o700);
    fs.rmSync(target);
    fs.mkdirSync(target);
    expectConfigError(() => loadConfig({ configPath: target, env: {} }), /regular file/);
  } finally { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a file larger than 64 KiB is refused", () => {
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({ sample_roots: Array.from({ length: 6000 }, (_, i) => `/data/${i}`) }));
    expectConfigError(() => loadConfig({ configPath: file, env: {} }), /too large/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("environment overrides win over the file and are validated", () => {
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({ edition: "lite", destructive: "confirm" }));
    const { config } = loadConfig({
      configPath: file,
      env: { BATUTA_EDITION: "suite", BATUTA_DESTRUCTIVE: "disabled", BATUTA_MAX_JUMP_DB: "2.5", BATUTA_MAX_MASTER_DB: "-3" },
    });
    assert.equal(config.edition, "suite");
    assert.equal(config.destructive, "disabled");
    assert.equal(config.gainGuard.maxJumpDb, 2.5);
    assert.equal(config.gainGuard.maxMasterDb, -3);
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_EDITION: "pro" } }), /BATUTA_EDITION/);
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_DESTRUCTIVE: "nope" } }), /BATUTA_DESTRUCTIVE/);
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_MAX_JUMP_DB: "abc" } }), /BATUTA_MAX_JUMP_DB/);
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_MAX_JUMP_DB: "NaN" } }), /BATUTA_MAX_JUMP_DB/);
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_MAX_MASTER_DB: "Infinity" } }), /BATUTA_MAX_MASTER_DB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("BATUTA_CONFIG selects the config path; default path lives in the runtime dir", () => {
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({ edition: "standard" }));
    assert.equal(loadConfig({ env: { BATUTA_CONFIG: file }, home: "/nonexistent" }).config.edition, "standard");
    const none = loadConfig({ env: {}, home: dir });
    assert.equal(none.source, "defaults");
    assert.equal(none.path, path.join(dir, "Library", "Application Support", "BatutaMCP", "server.json"));
    expectConfigError(() => loadConfig({ env: { BATUTA_CONFIG: "relative.json" }, home: dir }), /absolute/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("confirm policy (spec 9.1a): default irreversible; file key and BATUTA_CONFIRM accept irreversible or destructive only", () => {
  assert.equal(defaultConfig().confirm, "irreversible");
  assert.equal(parseConfig({}).confirm, "irreversible");
  assert.equal(parseConfig({ confirm: "destructive" }).confirm, "destructive");
  assert.equal(parseConfig({ confirm: "irreversible" }).confirm, "irreversible");
  for (const bad of ["always", "confirm", "disabled", true, 1, null]) expectConfigError(() => parseConfig({ confirm: bad }), /confirm/);
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({ confirm: "irreversible" }));
    assert.equal(loadConfig({ configPath: file, env: { BATUTA_CONFIRM: "destructive" } }).config.confirm, "destructive", "env wins over the file");
    assert.equal(loadConfig({ configPath: file, env: {} }).config.confirm, "irreversible");
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_CONFIRM: "nope" } }), /BATUTA_CONFIRM/);
    expectConfigError(() => loadConfig({ configPath: file, env: { BATUTA_CONFIRM: "" } }), /BATUTA_CONFIRM/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit allow_user_presets false still blocks presets", () => {
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({ browser: { allow_user_presets: false } }));
    const { config } = loadConfig({ configPath: file, env: {} });
    assert.equal(config.browser.allowUserPresets, false);
    assert.equal(config.browser.allowPlugins, true, "the other flags keep their defaults");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit allow_plugins false still blocks plugins", () => {
  const dir = makeDir();
  try {
    const file = write(dir, JSON.stringify({ browser: { allow_plugins: false } }));
    const { config } = loadConfig({ configPath: file, env: {} });
    assert.equal(config.browser.allowPlugins, false);
    assert.equal(config.browser.allowUserPresets, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
