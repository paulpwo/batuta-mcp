# Tests

Tests are TypeScript, compiled together with the sources by `tsc` (outDir `dist`), then run with
Node's built-in runner on the compiled output:

    pnpm test   # tsc -p tsconfig.json && node --test "dist/test/*.test.js"

Compiled output (not type stripping) is used because the supported floor is Node 22.14, where type
stripping is still behind a flag. A test that cannot compile is a failing test (RED).
`helpers/` holds the in-memory MCP client and the fake Remote Script (an AF_UNIX server in a
`/tmp/bm-*` directory that every test removes).

## Tool-layer tests (T5b)

`tools-*.test.ts` run the whole stack in memory: a `FakeScript` (the Remote Script's socket protocol), the
real `LiveClient`, the real tool registry and an in-memory MCP client (`helpers/tools-harness.ts`,
`startRig`). `helpers/fake-world.ts` answers the read commands the tool layer uses (track/scene/device
listings, mixer and parameter displays). Every rig is closed when its test file ends.

`fixtures/script-catalog.json` is the oracle for "one tool per command": the catalog entries and the
top-level argument names of the real Remote Script. Regenerate it after the script's command set changes
(from the repository root, with the standard library only):

    python3.12 -I -B -c 'import sys,json; sys.path.insert(0,"remote_script"); sys.dont_write_bytecode=True; \
      from BatutaMCP import command_set; r=command_set.build_registry(); out={"_about":"...","commands":[]}; \
      [out["commands"].append({"name":n,"mutating":callable(c.mutating) or bool(c.mutating),"destructive":c.destructive,\
      "conditions":list(c.conditions),"props":sorted(c.schema["props"]),"required":sorted(c.schema["required"]),\
      "at_least_one":bool(c.schema["at_least_one"]),"exclusive":[sorted(p) for p in c.schema["exclusive"]]}) \
      for n in r.names() for c in [r.get(n)]]; json.dump(out,open("server/test/fixtures/script-catalog.json","w"),indent=1)'
