import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";

/** Application views and the global launch quantization (script commands view_show, view_focus, view_get, song_set). */

test("show_view, focus_view and get_view reach their commands, read-only and without any destructive path", async () => {
  const r = await startRig({ answers: { ...new FakeWorld().answers(), view_get: () => ({ main: "arrangement", visible: { session: false, arrangement: true, detail_clip: true, detail_device: false, browser: true } }) }, echo: true });
  const shown = await r.call("show_view", { view: "arrangement" });
  assert.equal(shown.isError, false);
  assert.equal((await r.call("focus_view", { view: "browser" })).isError, false);
  const got = await r.call("get_view");
  assert.equal(got.structuredContent.main, "arrangement");
  assert.deepEqual(r.seen(), [{ cmd: "view_show", args: { view: "arrangement" } }, { cmd: "view_focus", args: { view: "browser" } }, { cmd: "view_get", args: {} }]);
  for (const name of ["show_view", "focus_view", "get_view"]) {
    const a = r.registry.get(name)!.tool.annotations!;
    assert.equal(a.readOnlyHint, true, name);
    assert.equal(a.destructiveHint, false, name);
  }
  for (const view of ["Arranger", "", "detail"]) assert.equal((await r.call("show_view", { view })).isError, true, view);
  await r.close();
});

test("views run inside a batch", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const out = await r.call("batch", { ops: [{ cmd: "show_view", args: { view: "session" } }, { cmd: "get_view", args: {} }] });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.deepEqual(r.seen().find((c) => c.cmd === "batch")?.args["ops"], [{ cmd: "view_show", args: { view: "session" } }, { cmd: "view_get", args: {} }]);
  await r.close();
});

test("clip_trigger_quantization is accepted as an index or a label by set_song_properties and nothing else", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  assert.equal((await r.call("set_song_properties", { clip_trigger_quantization: 4 })).isError, false);
  assert.equal((await r.call("set_song_properties", { clip_trigger_quantization: "1/16T" })).isError, false);
  for (const bad of [14, -1, "2 beats", 1.5, null]) assert.equal((await r.call("set_song_properties", { clip_trigger_quantization: bad })).isError, true, String(bad));
  assert.deepEqual(r.seen().map((c) => c.args["clip_trigger_quantization"]), [4, "1/16T"]);
  await r.close();
});
