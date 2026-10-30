# BatutaMCP Protocol and Security Specification (v1)

Status: normative for T2 to T8. Protocol number: `1`. Companion: `docs/00-research.md` (facts marked [V]/[A] there).
Keywords MUST, MUST NOT, SHOULD, MAY follow RFC 2119. `[A]` marks an assumption to verify in Live (collected in section 12). A deviation from `odd/tasks/batuta-mcp.md` is called out in section 2.5.

## 0. Conventions

- JSON text is UTF-8. Field names are `snake_case`. Optional request args may be omitted; optional result fields are always present (value `null` when not applicable).
- All numbers are finite JSON numbers. Integers are within +/- 2^53. `NaN`/`Infinity` are rejected. The parser uses `parse_float` that raises on non-finite results (e.g. `1e400` becomes inf) and `parse_constant` for the literals. A JSON boolean is never accepted where a number or integer is expected (Python `bool` is an `int`: validators test `type(x) is bool` first).
- Time and lengths are in beats (quarter note = 1.0, float). Indices are 0-based.
- Strings: max 4096 bytes UTF-8 in general; names (track, scene, clip, cue, device-chain) max 128 code points. Control characters (U+0000..U+001F, U+007F..U+009F) and bidi overrides (U+202A..U+202E, U+2066..U+2069) are rejected on input (`invalid_args`) and stripped on output.
- Every numeric limit is collected in Appendix A.

## 1. Components and trust boundaries

```
MCP client (Claude Code)
   |  stdio, MCP JSON-RPC            [boundary B1: model/prompt output is untrusted input]
TypeScript server  @paulpwo/batuta-mcp  (Node >= 22.14)
   |  AF_UNIX stream socket          [boundary B2: other local processes]
Python 3.11 Remote Script "BatutaMCP"  (inside Live, plain create_instance object)
   |  Live Object Model (main thread only)   [boundary B3: Live itself]
Ableton Live 12 (Lite or Suite), macOS
```

| Component | Responsibility | Trusts |
|---|---|---|
| MCP client | Tool calls, human approval UI | Human user |
| TS server (zero runtime dependencies: own MCP stdio JSON-RPC layer and schema validator, Node built-ins only) | Tool schemas, name resolution, edition prechecks, destructive confirmation, timeouts, file validation, loudness analysis | Remote Script output as data only; never executes it |
| Remote Script | Authenticated socket, strict schema check, allowlisted dispatch to fixed functions, LOM calls, undo steps | Nothing from the socket until authenticated and schema-checked |
| Live | Executes LOM calls | n/a |

The TypeScript server makes no outbound network calls and spawns no processes except in `server/src/host/runner.ts` (`/usr/bin/open` and `/usr/bin/osascript` only, argv arrays, `execFile`, never a shell; the runner enforces its own argv contract — osascript only `-e` plus one of the constant scripts plus data arguments, open only `-a` plus absolute paths — and may be imported only by `host/host.ts` and `tools/index.ts`; host calls are serialized, Live always gets the real path, and host action-log entries carry `outcome`; docs/04-host-automation.md): no other `child_process`, no `fetch`/`http`/`net.connect` other than the AF_UNIX socket to the Remote Script, no DNS. Its only I/O is stdio, the runtime dir (read), the validated audio files (read) and its config file (read).

### 1.1 Threat model

| # | Threat | Mitigation |
|---|---|---|
| T-1 | Other local user or process connects to the socket | Dir 0700 and socket 0600 owned by the user, token handshake (64 hex, `hmac.compare_digest`), single client, auth lockout (section 3.4) |
| T-2 | Prompt injection makes the model call tools harmfully | Closed command allowlist; no save/open/export/file write/subprocess/arbitrary property access; destructive confirmation (section 9) plus `destructive: "disabled"` config; strings from Live (names, browser items) are returned as data, length-capped and control-stripped |
| T-3 | Web page / browser attack incl. DNS rebinding | No TCP/HTTP listener exists in v1. Browsers cannot open AF_UNIX sockets. The MCP side is stdio only. If an HTTP transport is ever added it MUST bind 127.0.0.1, validate `Host` and `Origin`, and require a bearer token (new spec revision) |
| T-4 | Malformed frames (bad length, bad JSON, binary) | Length cap, depth cap, duplicate-key rejection, strict per-command schemas, bad-frame counter (section 3.2) |
| T-5 | Oversized payloads / memory exhaustion | 1 MiB frames both ways, array and string caps, queue cap, response cap, pagination |
| T-6 | Request flooding / DoS of Live's UI thread | Rate limit, in-flight cap, 20 ms drain budget, bounded handlers |
| T-7 | Path traversal or symlink swap on recorded files | Remote Script never opens audio files. Server validates realpath, roots, extension, size, regular file, owner, `O_NOFOLLOW`, fd-based `fstat` (section 10.5) |
| T-8 | Token theft via logs or error messages | Token never logged, never in error text, never in MCP output; only compared in constant time |
| T-9 | Stale or hijacked socket path | Script refuses non-owned, symlinked or loose-permission dir; server checks the same before connecting (section 2) |
| T-10 | Confused-deputy file import (`audio_clip_create`) | Works without configuration. The server resolves the realpath and accepts only an existing regular audio file (extension allowlist, owner, single hard link, size cap, WAV/AIFF header parse), then sends only its own realpath; the script re-checks lexically and Live, not BatutaMCP, opens the file. Optional `sample_roots` narrows imports to those folders (section 7.6) |
| T-11 | Loudness/hearing harm: model raises master or track gain, or a gain parameter, by a large amount | Gain guard (section 9.4): large jumps and master above `max_master_db` need confirmation, or are rejected when destructive is disabled |
| T-12 | Microphone/line-in capture: arming or monitoring an audio input, recording while an external source is live, or External Audio Effect / External Instrument devices | Script-enforced recording safety rule (section 5.6): no arming of audio tracks except the script's own ears track, no monitoring In, no record start while an external-live track exists, each unless the owner confirms the recording of the external input once (acknowledgement set only by the server); External* devices load by default (`browser.allow_external_devices`, owner decision 2026-10-30; `false` blocks them); fail closed; required tests |
| T-13 | Loading Max for Live, plugin, External* or other untrusted content, or a different set, through `browser_load` | Allowlist by browser category and URI (section 7.10); `.als` never; `.amxd` and `max_for_live` only with `browser.allow_max_for_live` (default true), External* only with `browser.allow_external_devices` (default true); user content only with `browser.allow_user_presets`; plugins only with `browser.allow_plugins`; post-load cleanup (cannot stop code that already ran on load) |
| T-14 | Model misuses host automation (overwriting or opening sets, running programs) | One isolated module; the AST scan allows `node:child_process`/`execFile` only in `host/runner.ts`; fixed binaries; constant AppleScript with every variable passed through argv; path rules plus the optional `host.set_roots`; confirmation before replacing an existing file; `host.enabled:false` removes the tools (docs/04-host-automation.md) |

### 1.2 Out of scope

- A process running as the same OS user that can read the token file is equivalent to the user (it could also edit the Remote Script or Live preferences). No defense is attempted.
- Malicious or compromised Live, macOS, Node, or the MCP client itself. Malicious Live sets or third-party devices loaded by the user.
- Confidentiality of traffic on the local socket against a root user.
- Preventing a legitimately approved destructive action. Confirmation is a safeguard against accidents and unreviewed model calls, not against a human approving it.
- Windows and Linux (macOS only in v1).

## 2. Files and paths

### 2.1 Layout

| Item | Path | Mode | Created by |
|---|---|---|---|
| Runtime dir | `~/Library/Application Support/BatutaMCP/` | 0700, owner = current user | Remote Script on load, if missing |
| Socket | `<runtime dir>/live.sock` | 0600 | Remote Script (bind, then `chmod`) |
| Token | `<runtime dir>/token` | 0600, exactly 64 lowercase hex chars, no newline | Remote Script on load, if missing |
| Config (server) | `~/Library/Application Support/BatutaMCP/server.json` or env overrides | 0600 | Owner; read only by the server; the Remote Script never reads it |

`~` is `os.path.expanduser("~")`; the Remote Script does not read environment overrides. `BATUTA_*` env vars exist for the server only (section 8, 9).

### 2.2 Remote Script startup checks (all MUST pass, otherwise the script logs one line via `c_instance.log_message` and does not listen)

1. Resolve `runtime_dir`. If missing: `os.mkdir(path, 0o700)` then `os.chmod(path, 0o700)` (parent `~/Library/Application Support` must exist).
2. `os.lstat(runtime_dir)`: MUST be a directory (not a symlink), `st_uid == os.getuid()`, `(st_mode & 0o077) == 0` and `(st_mode & 0o700) == 0o700`. Otherwise refuse (never `chmod` an existing dir to fix it).
3. Socket path bytes length (`len(os.fsencode(path))`) MUST be <= 103 (macOS `sun_path` is 104 incl. NUL). Otherwise refuse.
4. Token: if `token` missing, create it atomically: `secrets.token_hex(32)` written to `token.tmp.<16 hex chars from secrets.token_hex(8)>` (random suffix, not the pid) opened with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, then `os.link(tmp, token)` (fails if it exists) and `os.unlink(tmp)`. If present: open first with `O_NOFOLLOW|O_RDONLY`, then `os.fstat(fd)` MUST be a regular file, owner = user, `(mode & 0o077) == 0`, size 64, and `os.lstat(path)` MUST report the same `st_dev` and `st_ino` (closes the check-then-open race); read 64 bytes, verify `^[0-9a-f]{64}$`. Otherwise refuse.
5. Socket: if `live.sock` exists, `lstat` MUST be a socket owned by the user; attempt a `connect()` (timeout 200 ms): success means another instance is live, so refuse; `ECONNREFUSED` means stale, so `os.unlink` it. Then `bind`, `chmod 0600`, `listen(1)`.
6. On `disconnect()`: close client and listener, `os.unlink` the socket. Never touch the token on exit.

### 2.3 Server checks before every connect (read-only)

`lstat` runtime dir (dir, uid, no group/other bits, not symlink); open the token with `O_NOFOLLOW|O_RDONLY`, `fstat` the fd (regular, uid, no group/other bits, size 64), require `lstat(path)` to report the same `st_dev`/`st_ino`, then read it; `lstat` socket (`S_ISSOCK`, uid). Any failure: refuse with a message naming the path and the violated rule, without printing the token. The server never creates, chmods or deletes anything in the runtime dir, with one exception: the remembered-edition hint `last-edition.json` (docs/04-host-automation.md section 3.1), written only by `host/last-app.ts`, never through a link, and only into a runtime dir that passed the checks above.

### 2.4 File operations the Remote Script may perform (exhaustive)

`mkdir`/`chmod`/`lstat` on the runtime dir; create-exclusive, link, unlink, read of the token; `connect`/`bind`/`chmod`/`unlink` on `live.sock`. Nothing else: no other open, no `os.system`, no `subprocess`, no `eval`/`exec`/`compile`/`__import__` on client data, no `getattr`/`setattr` with client-supplied names, no network except the AF_UNIX listener, no threads other than one socket thread.

### 2.5 Deviation from the feature document

The feature document's acceptance line says the script reads the token only. This spec lets the script create the dir and token when missing (task T1 instruction); the exhaustive list in 2.4 replaces that line. T2 grep checks MUST allow exactly those calls.

## 3. Transport framing and session

### 3.1 Frame

```
+----------------+---------------------------+
| u32 BE length  | UTF-8 JSON object (length bytes) |
+----------------+---------------------------+
```

- `1 <= length <= 1_048_576` (1 MiB). Both directions. Top-level JSON MUST be an object.
- Length 0 or > 1 MiB: receiver sends (if the socket is writable) `{"type":"error","error":{"code":"too_large"|"bad_request",...}}` and closes WITHOUT reading the body.
- Once a header is read, the body MUST arrive within 5 s, else close.
- The socket thread uses non-blocking sockets with `selectors`. A pending send that makes no progress for 5 s closes the connection, so a stalled reader cannot block the thread.
- JSON parse rules: reject invalid UTF-8; reject duplicate keys (`object_pairs_hook`); reject `NaN`/`Infinity` (`parse_constant`); nesting depth <= 32, checked by a linear byte scan (counting `[` `{` outside strings) BEFORE calling `json.loads` so deep input cannot cause `RecursionError`; arrays <= 10 000 elements; objects <= 256 keys.
- Frames carry `type` (connection-level: `hello`, `welcome`, `ping`, `pong`, `error`) or `cmd` (requests) or `ok` (responses).

### 3.2 Bad frames

After authentication a malformed JSON or schema-invalid frame yields an error response (`bad_request`, with `id` if recoverable, else `id: null`) and the connection stays open. 5 consecutive bad frames close the connection. Before authentication any defect closes it.

### 3.3 One client at a time

The script accepts a second connection only to send `{"type":"error","error":{"code":"busy","message":"another client is connected"}}` and close it, without reading from it. A client that has sent nothing for 120 s is closed (idle timeout), which frees the slot. The server reconnects with backoff 0.5, 1, 2, 4, 8, 15 s (cap 15 s), jitter +/- 20 %, and treats `busy` as retryable. While a delay longer than 1 s runs, the server looks at `live.sock` once a second (one `lstat`, no connection attempt) and reconnects at once when the entry changed (created, or re-created with a new inode), restarting the sequence at 0.5 s; so a Live restart is noticed within about a second of its socket appearing instead of after the rest of a 15 s delay. A socket that does not change is not retried early.

### 3.4 Handshake

1. Client sends within 5 s of connect: `{"type":"hello","protocol":1,"token":"<64 hex>","client":"batuta-mcp/<semver>","edition_hint":"lite/standard/suite","allow_plugins":false,"allow_user_presets":false}`. `client` (<= 64 chars), `edition_hint`, `allow_plugins` and `allow_user_presets` (bools, default false, from server config `browser.allow_plugins` / `browser.allow_user_presets`; used by section 7.10) are optional. Optional `allow_max_for_live` and `allow_external_devices` (bools; the server sends its config values `browser.allow_max_for_live` / `browser.allow_external_devices`, default true; a hello without them counts as false, fail closed; sections 7.10 and 5.6). Optional `allow_audio_import` (bool, default false): the server always sends true (section 7.6; `sample_roots` only narrows imports); a client that omits it or sends false is refused by the script `audio_clip_create` with `not_supported` reason `disabled_by_config`.
2. Script verifies `protocol` is an int and equals 1. Mismatch: `{"type":"error","error":{"code":"bad_request","message":"unsupported protocol","details":{"supported":[1]}}}`, close.
3. Token compare: `hmac.compare_digest(received.encode("ascii"), expected)` on bytes; non-ASCII or wrong length counts as failure.
4. Failure: `{"type":"error","error":{"code":"auth_failed","message":"authentication failed"}}`, close. After 5 failures within 60 s the script closes new connections immediately for 30 s (no reply).
5. Success: `{"type":"welcome","protocol":1,"live_version":"12.4.7","script_version":"0.1.0","edition":"lite","edition_source":"detected","max_frame":1048576,"limits":{"max_inflight":16,"rate_per_s":50,"burst":100}}`.
   - `edition` is `lite|standard|suite|unknown`; `edition_source` is `detected|hint|none`. If detection (section 8) yields unknown, a valid `edition_hint` is used; else `unknown`.
6. Any frame other than `hello` first is a defect: close.

### 3.5 Keepalive, flow control, rate limit

- `{"type":"ping"}` is answered by `{"type":"pong"}`. The server sends a ping every 30 s while idle.
- In-flight requests (accepted, unanswered) <= 16; the 17th gets `busy` with `details.reason = "inflight"`. The queue holds at most 64 items; overflow yields `busy` with `details.reason = "queue_full"`.
- Responses are written in request order (FIFO), except immediate rejections (`busy`, `rate_limited`, `bad_request`, and the pre-queue `unknown_command` and `invalid_args`), which are written at once. While a client's unsent output exceeds 4 MiB the script stops reading from it (backpressure); the 5 s send timeout closes a stalled reader, and (16 + 1) × 1 MiB is a last-resort hard cap. The client correlates by `id` and MUST NOT assume order.
- Rate limit: token bucket, refill 50/s, capacity 100. Excess gets `rate_limited` with `details.retry_after_ms`. Pings do not count. A sustained violator (> 500 rejected in 10 s) is disconnected.

## 4. Request, response, errors

```
request : {"id": <int 0..2^53>, "cmd": "<name>", "args": {...}, "timeout_ms": <int 100..30000, optional>}
success : {"id": n, "ok": true,  "result": {...}}
failure : {"id": n, "ok": false, "error": {"code": "...", "message": "...", "details": {...}}}
```

`id` MUST be unique among in-flight requests. `args` MUST be present (use `{}`). Unknown top-level keys, unknown `cmd`, and unknown args are errors (strict). `message` is a human sentence <= 300 chars without secrets; `details` is optional machine data.

| Code | Produced by | Meaning | Retry |
|---|---|---|---|
| `bad_request` | script, server | Malformed frame, bad JSON, missing `id`/`cmd`, protocol mismatch | no |
| `unknown_command` | script | `cmd` not in allowlist (`details.cmd`) | no |
| `invalid_args` | script, server | Schema violation, ambiguous name (`details.reason = "ambiguous_name"`, `candidates`), bad/expired confirm (`details.reason`), overlap without `allow_overwrite` (`details.reason = "overlap"`), `transport_running` (cue edits) | no |
| `not_found` | script, server | Track, scene, clip, device, parameter, routing option, browser URI absent (`details.what`, `details.index`); `expect_name` / `expect_start` / `expect_time` mismatch (`details.reason = "name_mismatch"` etc.), the single code for every guard mismatch | no |
| `out_of_range` | script | Value outside min/max or index outside list (`details.min`, `max`, `value`) | no |
| `edition_limit` | script, server | Lite limit would be exceeded (`details.resource`, `limit`, `current`, `edition`) | no |
| `lom_error` | script | Live raised; message is the exception text (<= 300 chars), `details.exception` = class name, `details.partial` = true if any mutation already happened | maybe |
| `timeout` | script, server | Server-side deadline passed (see 5.4); also ears recording or file-finalization deadlines (`details.stage`) | maybe |
| `busy` | script, server | Second client, inflight/queue full (script); ears job already running (server, `details.reason = "job_running"`) | yes |
| `auth_failed` | script | Handshake failure | no |
| `too_large` | script, server | Frame or response > 1 MiB, list cap exceeded | no (paginate) |
| `rate_limited` | script | Token bucket empty | yes |
| `version_mismatch` | server | The script's `catalog` lacks the command or disagrees on `mutating` (per tool), or the catalog is unreadable (all tools); hint: reinstall matching versions | no |
| `confirmation_failed` | server | Elicitation errored or returned an invalid answer; fails closed | no |
| `not_supported` | script, server | Capability absent or refused by policy (`details.reason`: `live_version`, `edition`, `disabled_by_config`, `arrangement`, `blocked_content`, `audio_arm_blocked`, `monitor_in_blocked`, `external_input_live`, `record_mode_on`, `gain_limit`) | no |
| `cleanup_failed` | server | Ears cleanup could not delete the temporary track (`details.manual` holds the instruction); never produced by the script | no |

Connection-level errors use `{"type":"error","error":{...}}` (no `id`).

## 5. Execution model

### 5.1 Threads

- Exactly one socket thread: `accept`, framing, auth, rate limiting, JSON parse, structural and schema validation, enqueue of validated requests into a `queue.Queue(maxsize=64)`, and writing responses from an outbound `queue.Queue`.
- LOM is touched only from Live's main thread. `update_display()` (about every 100 ms [A: also when Live is in the background]) drains the request queue with a monotonic budget of 20 ms: it starts items until 20 ms elapsed, always processing at least one per tick. A handler MUST be bounded (caps in Appendix A); a handler MAY exceed the budget but never loops unbounded.
- `browser_search` is a generator handler: the drain resumes it each tick for up to 15 ms until done or its node cap (3000) is hit.
- A handler may also yield `NEXT_TICK` (`dispatcher.NEXT_TICK`): the drain then resumes it on the next `update_display` tick, never later in the same one. Live applies some writes (playhead, play state) only on its next tick, so `transport`, `cue_create` and `cue_delete` write, wait one tick and then read. These three are mutating generator handlers: they register with `undo_wrapped=false` and open their own single undo step around the writes. Inside `batch` there is no tick to wait for: `transport` runs synchronously (its reply shows the state before Live applied it) and `cue_create`/`cue_delete` are refused (`not_supported`, `details.reason="needs_ticks"`).
- `disconnect()` stops the thread, closes sockets, unlinks the socket path, and drains nothing further.
- Max throughput is therefore tens of commands per tick but at minimum ~10 per second; the server SHOULD use `batch` (section 7.1) for multi-step edits.

### 5.2 Dispatch

A module-level literal `COMMANDS = {"name": Command(schema, handler, mutating, destructive)}`. Lookup by `dict.get(name)` only. Handlers are fixed functions. Schemas are declarative dicts validated by a small in-repo validator (types, enums, ranges, max lengths, no extra keys). No `getattr`, `setattr`, `eval`, `exec` on client data.

### 5.3 Undo and mutation rules

- A command with `mutating = yes` runs as: validate all args and resolve all references first (no LOM mutation before validation completes); `song.begin_undo_step()`; `try: handler`; `finally: song.end_undo_step()`. Exactly one pair per command (`batch` is one command: one pair for all ops; inside it, references are resolved per op at execution time, see 7.1).
- `mutating = no` commands MUST NOT call any setter, creator, `fire`, selection change or playhead change. Reads that need selection or playhead (none in v1) are forbidden.
- If a handler raises after partially mutating, the script does not auto-undo; it returns `lom_error` with `details.partial = true` and the step stays on the undo stack for the user.
- `undo`/`redo` are not wrapped in an undo step. Temporary state changes (selected track for `browser_load`, playhead for `cue_create`/`cue_delete`) are restored by the same handler (the playhead on a later tick, see 5.1), also when the handler is closed early.
- Nested `begin_undo_step` is never used [A: behavior if Live is already inside a step].

### 5.3a Status bar feedback

After a mutating command, the script shows one line in Live's status bar with `c_instance.show_message`, as ClyphX does.

- Success: `BatutaMCP: <command> <details>`, for example `BatutaMCP: song_set tempo=101`. Refused or failed (any error code): `BatutaMCP: <command> refused (<code>)`. `batch` shows one line: `BatutaMCP: batch (<n> ops)`.
- Read-only commands show nothing, so polling never touches the bar.
- The line holds only the command name from the registry, integers, rounded floats, booleans and enum keywords the schema already validated: refs numbered as Live shows them (`track 1` is wire index 0; slots, scenes and devices also from 1; returns as letters, `return A` is index 0; `master`), plus at most 3 `key=value` pairs. Names, URIs, paths, note lists and any other free text from the arguments, and model text, never appear. ASCII only, whitespace collapsed, at most 120 characters.
- It is shown after `end_undo_step`, is not a mutation, and is failure-isolated: an error from `show_message` is swallowed and logged once, and never changes the response or the undo step. There is no config flag.

### 5.4 Timeouts

- Default server-side per-request deadline 5 s (browser_search 15 s, batch 10 s, ears polling reads 5 s). It is sent as `timeout_ms`; the script discards queued, not-yet-started items past their deadline with `timeout`. A running handler is never interrupted.
- When the server sees a `timeout` or its own timer fires for a MUTATING command, the outcome is unknown: it MUST re-read state (listing) before any retry and MUST NOT blindly retry destructive commands.
- Whole-connection: hello 5 s, frame body 5 s, idle 120 s.

### 5.5 Logging

Script logs via `c_instance.log_message`: startup refusal reasons, connect/disconnect, auth failures (count only), handler exceptions (class and message). Never frame contents, never the token.

### 5.6 Recording safety rule (no microphone or line-in capture)

Goal: BatutaMCP never starts capturing a microphone or line input on its own. Layers: (1) it cannot arm audio tracks, (2) it cannot monitor audio inputs, (3) it cannot start recording while an external source is live. Owner decision 2026-10-30: layers (1) to (3) are no longer final for an external input. The script still refuses by default, the refusal carries `details.acknowledgeable: true` and the tracks, and the SERVER asks the owner once (elicitation or `batuta_confirm`, same timeout as the other confirmations): the question names the tracks and says the recording may capture whatever comes in through the external input (for example a microphone). The refusal carries `details.tracks` (names, shown) and `details.track_ids` (the stable identity, bound): `t<i>` track position, `r<i>` return position, `m` master (positions, because names may repeat). On accept the server sends the same request again with the request-frame key `external_input_ack: {tracks: [<the ids it showed>]}`; the script accepts it only while EVERY external-live track (plus the track the command itself would make external-live, such as the one being armed or receiving an External device) is in that list, else it refuses acknowledgeable again with the new list and the server asks once more (at most two questions per call, then the refusal is the error). The question shows at most 8 names and then `and N more`; the ack always carries every id. On decline the result is `cancelled` and nothing happens; no answer is the usual `confirmation_failed` timeout. A client that cannot ask (no elicitation) means refuse: the call returns `not_supported`/`external_input_live` saying it needs the owner's confirmation, nothing is stored, and `batuta_confirm` can never release it. `external_input_ack` is a frame key, never a tool argument (tool schemas and the script's command schemas reject it as an argument; the frame validator accepts only that object shape, a bare `true` is `bad_request`), it applies to that one request only, and inside a `batch` the up-front precheck covers every op against the current state, so one question and one re-send suffice. An op that needs the ack only because an EARLIER op of the same batch changed the set (an External device inserted, a record flag turned on) is refused at that op: the batch stops there, the error is not acknowledgeable and carries `details.ops_run` (the batch result has `partial: true`), and it is never re-sent whole. Inserting or loading an External device (`device_insert`, `browser_load`, racks and batches included) while a recording is possible (`record_mode` or `session_record` on, a clip slot recording, or the ears track in the set) goes through the same ask; an External device that lands unannounced under those conditions without a covering ack is removed like a blocked one. `song_info.external_live_tracks` lists `{id, name}` of the script's own external-live tracks (the ears gate uses it). What is never relaxed: audio tracks with a SAFE input stay unarmable, the ears track rules (reserved name, only the script arms it, its input must be SAFE), `routing_set` rule 3, and `undo`/`redo` asking.

**Definitions**
- *Routing type object*: an entry of `available_input_routing_types` / `input_routing_type`, with `display_name` and `attached_object` [A35].
- *SAFE input*: a routing type object whose `attached_object` is a Track (track or return) of this set, or whose category is Resampling or No Input. Classification is by OBJECT, never by display name. Fallback if `attached_object` is unavailable [A35]: a type is SAFE only if its display name equals exactly one track/return name AND no track/return name equals a non-track type name offered on that track (`Ext. In`, `Resampling`, `No Input`, and similar); any collision makes every type with that name external.
- *Ears track*: the one audio track the script created itself with `track_create {type:"audio", name:"batuta-ears", ears_internal:true}`. `ears_internal` is a server-only flag: the script accepts it on the wire, the MCP tool `batuta_track_create` does not expose it in its schema and rejects the reserved name `batuta-ears` (also for `track_set` renames). The script stores that track OBJECT (identity, not name) as `ears_track`; at most one exists (a second create is `invalid_args`); cleared when it is deleted or on disconnect. Renaming it does not change its identity; a track named `batuta-ears` created without the flag is not the ears track.
- *External-live track*: any track of the set (regular, return, master or group) that has a non-SAFE input and (`arm` true or monitoring In), or contains an External Audio Effect or External Instrument device (class names [A38]), found by walking devices, chains, return chains and drum pads (depth <= 8, <= 500 devices). The owner may create such tracks by hand.
- *Ears gate*: ears are refused while ANY external-live track exists in the set. This is deliberately global (it covers vocoder, sidechain and send paths that routing inspection could miss), so no per-source analysis exists.

**Rules (script, checked at execution time, never cached, per op inside `batch`)**
1. `track_set arm:true` is refused on every audio track except the ears track; on the ears track it is refused unless its current input is SAFE. MIDI tracks may be armed. Reason `audio_arm_blocked`. On an audio track whose input is external (readable and not SAFE) the refusal is acknowledgeable (see the goal above); an unreadable input or a SAFE-input audio track stays a plain refusal.
2. `track_set monitoring_state: 0` (In) is refused on every audio track; Auto and Off are allowed. Reason `monitor_in_blocked`; acknowledgeable on a track whose input is external.
3. `routing_set` input matching: the display name is matched against the available objects. If several objects share the name the call fails `invalid_args` (ambiguous, candidates listed); the script never picks one. If the result would leave ANY audio track whose input is in use (armed, or monitoring In) with a non-SAFE input, the call is refused: `audio_arm_blocked` when armed, `monitor_in_blocked` when monitoring In.
4. While an external-live track exists, commands that would START RECORDING or capture audio are refused unless acknowledged (`external_input_live`, `acknowledgeable: true`, `details.tracks`): `slot_fire` with `record_length`; `slot_fire` or `scene_fire` that would fire an empty slot on an armed track; `trigger_session_record`; `song_set` enabling `record_mode`, `session_record` or `arrangement_overdub`; `slot_fire`, `scene_fire` and `transport` start/continue while `record_mode` or `session_record` is already on.
5. Ears (server pre-flight, section 10.2 step 0) asks the owner once while any external-live track exists, naming the tracks (`batuta_ears`, `record_and_analyze`): on accept every command of that job carries `external_input_ack` bound to the ids shown (the shown tracks are the script's `song_info.external_live_tracks`, which also covers External devices, plus the best-effort armed/monitored inputs); on decline the result is `cancelled` before anything is created; a client that cannot ask keeps the refusal (`external_input_live`). The ears track itself stays subject to rule 1 (its input must be SAFE).
6. `track_duplicate` of an external-live track is refused unless acknowledged (`external_input_live`): a copy would duplicate an armed or monitored external path or an External* device. Duplicating the ears track or any armed audio track is refused (`audio_arm_blocked`): the copy could be an armed audio track that is not the ears track [A41: whether `duplicate_track` copies arm state].

Stated tradeoff: plain playback with the record flags off stays allowed even while a microphone is monitored by the owner. BatutaMCP cannot stop the owner from arming, monitoring or recording by hand; it only refuses to arm audio tracks, monitor inputs or START recording while an external source is live. Blocking all playback would break normal use.

Required tests (fake `Live` module, T2/T3; server pre-flight, T5): (a) arming any audio track except the ears track is refused, MIDI arming works; (b) arming the ears track works with a Track or Resampling input and is refused with an external input; (c) monitoring In refused on an audio track, Auto/Off allowed; (d) two input types sharing a display name make `routing_set` fail as ambiguous; (e) with an external-live track present, every rule-4 command is refused, while `mixer_set` and `transport start` with record flags off are allowed; (f) with any external-live track present, the server refuses ears for every source (master, return, group, plain) and the script refuses `track_duplicate` of that track; (g) an External Audio Effect inside a rack chain or drum pad makes its track external-live; (h) inside `batch`, an arm-then-route sequence is checked per op; (i) a user-created track named `batuta-ears` cannot be armed, and renaming the real ears track does not change its status; (j) rename a track "Ext. In", then try to route to it or arm: refused; (k) the external-live walk finds an External device on a regular, return, master and group track; (l) `batuta_track_create` rejects the name `batuta-ears` and does not expose `ears_internal`; (m) a Pack `.adg` reached through `sounds` is refused when `allow_user_presets` is false (7.10).

## 6. Addressing, units, common types

### 6.1 Reference types

| Type | JSON shape |
|---|---|
| `TrackRef` | `{"kind":"track","index":n}` or `{"kind":"return","index":n}` or `{"kind":"master"}`; optional `"expect_name":"..."` (mismatch gives `not_found` with `details.reason="name_mismatch"`) |
| `Scene` | integer index 0..n-1 (arg named `scene`); optional `expect_name` arg on destructive commands |
| `SlotRef` | `{"track":TrackRef,"slot":n}` (`track` MUST be kind `track`; session clips exist only there) |
| `ClipRef` | `{"kind":"session","track":TrackRef,"slot":n}` or `{"kind":"arrangement","track":TrackRef,"index":n,"expect_start":beats?}` (index into `arrangement_clips`; `expect_start` guards against shifting; tolerance 1e-6 beats) |
| `DeviceRef` | `{"track":TrackRef,"path":[d0, step1, step2, ...]}`; `d0` is the device index on the track; each step is `{"chain":c,"device":d}`, `{"return_chain":c,"device":d}` or `{"drum_pad":note,"chain":c,"device":d}`; path length <= 8 |
| `ContainerRef` | Same shape as `DeviceRef` but `path` may be empty (the track's own device chain) and the last step may omit `device` to name a chain as the container: `{"chain":c}`, `{"return_chain":c}`, `{"drum_pad":note,"chain":c}`. Used by `device_list` and `device_insert` |
| `ParamRef` | `{"device":DeviceRef,"index":p}` or `{"mixer":"volume"\|"pan"\|"send","track":TrackRef,"index":sendIndex?}` (`index` only for `send`) |

In every args table of section 7 an arg named `track` is a `TrackRef` (kind restrictions are noted in parentheses); `slot`, `index`, `scene` are plain integers; `SlotRef`/`ClipRef` embed a `TrackRef`. Results use the same shapes.

Name lookup (tracks, returns, scenes, devices, parameters, clips by name) is performed by the SERVER against a fresh listing, never by the script: exact case-sensitive match, then exact case-insensitive; more than one match gives `invalid_args` (`ambiguous_name`, up to 10 `candidates` with index and name); none gives `not_found`. The resolved reference gets `expect_name` automatically. Index meaning: `track` indices exclude returns/master; send index i corresponds to return track i (A=0).

### 6.2 Units and value conventions

| Quantity | Unit / convention |
|---|---|
| Time, length, positions | beats (float). Song time = arrangement position. Note `start_time` is relative to clip start |
| Tempo | BPM 20..999 |
| Parameter values | raw LOM value, always accompanied by `min`, `max`, `default`, `display` (`str_for_value(value)`) |
| Volume / send | raw 0.0..1.0 (0.85 is about 0 dB); result adds `volume_db` (float or `null`), parsed from `str_for_value`; setting accepts raw `volume` or `volume_db` (-70..6) mapped by the script via bisection over `str_for_value` (<= 24 iterations); if not derivable, `invalid_args` |
| Pan | -1.0..1.0 |
| Color | integer 0xRRGGBB (0..16777215) |
| Pitch | 0..127; velocity 1..127 (float) |
| Meters | 0.0..1.0 linear (Live output meter), not dB |

### 6.3 Common result objects

- `TrackInfo`: `kind, index, name, color, mute, solo, arm, can_be_armed, has_midi_input, has_audio_input, is_foldable, fold_state, group_track_index, monitoring_state (0 in, 1 auto, 2 off), device_count`. Fields not applicable (master/return) are `null`.
- `SceneInfo`: `index, name, color, tempo (number or null), time_signature ([n,d] or null), is_triggered`.
- `SlotInfo`: `track (TrackRef), slot, has_clip, is_playing, is_recording, is_triggered, clip (ClipSummary or null)`.
- `ClipSummary`: `name, color, length, is_midi, is_audio, looping, muted`.
- `ClipInfo`: `ClipSummary` plus `kind, track (TrackRef), slot_or_index, start_time, end_time, loop_start, loop_end, start_marker, end_marker, signature [n,d], is_playing, is_recording, file_path (audio only, else null), sample_rate (audio only [A], else null), gain, pitch_coarse, pitch_fine, warping`.
- `Note`: `note_id, pitch, start_time, duration, velocity, mute, probability (0..1), velocity_deviation (-127..127), release_velocity (0..127)`.
- `DeviceInfo`: `path, name, class_name, type, is_active, can_have_chains, can_have_drum_pads, parameter_count`.
- `ParamInfo`: `index, name, value, min, max, default, display, is_quantized, value_items (array or null), is_enabled, automation_state`.
- Lists: `{"items":[...], "total":n, "next_offset":n|null}`, args `limit` (default 100, max 500 unless the command says otherwise) and `offset`. A result that would exceed 1 MiB gives `too_large`.

## 7. Command catalog v1

Columns: **M** mutating (undo step), **D** destructive (section 9): `no` = `never`, `yes` = `always`, `if X` = `conditional` on X. Every mutating command is one undo step. "LOM" lists the calls used; no command touches anything outside the LOM except where stated.

### 7.1 Session, transport, meta (11)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `catalog` | `{}` | `{commands:[{name,mutating,destructive:"never"/"always"/"conditional",conditions:[arg names]}], script_version}` | no | no | none |
| `song_info` | `{}` | `{tempo, signature:[n,d], is_playing, current_song_time, loop:{on,start,length}, metronome, record_mode, arrangement_overdub, session_record, root_note, scale_name, track_count, return_count, scene_count, cue_count, can_undo, can_redo, selected_track:TrackRef, live_version}` | no | no | `tempo`, `signature_*`, `is_playing`, `current_song_time`, `loop*`, `metronome`, `record_mode`, `arrangement_overdub`, `session_record`, `root_note`, `scale_name`, `can_undo`, `can_redo`, `view.selected_track` |
| `song_set` | any of `tempo` 20..999, `signature_numerator` 1..99, `signature_denominator` in {1,2,4,8,16}, `metronome`, `loop`, `loop_start` >=0, `loop_length` >0, `record_mode`, `arrangement_overdub`, `session_record`, `root_note` 0..11, `scale_name` (<=64; a Live exception on an unknown scale is mapped to `invalid_args`), `clip_trigger_quantization` (int 0..13 or exact label "none","8 bars","4 bars","2 bars","1 bar","1/2","1/2T","1/4","1/4T","1/8","1/8T","1/16","1/16T","1/32"; `song_info` reports `{index,label}` or null) [A]; at least one field; `record_mode`/`session_record`/`arrangement_overdub` true subject to 5.6 rule 4 | `{applied:[names]}` | yes | no | same setters |
| `transport` | `{action:"start"/"continue"/"stop"}`; start/continue subject to 5.6 rule 4 | `{is_playing, current_song_time}` read one tick after the write, so `is_playing` is the new state | yes | no | `start_playing`, `continue_playing`, `stop_playing` |
| `song_set_time` | `{time: >=0}` | `{current_song_time}` (read one Live tick after the write; inside `batch` no tick wait) | yes | no | `current_song_time` |
| `stop_all_clips` | `{quantized?: bool=true}` | `{}` | yes | no | `stop_all_clips` |
| `back_to_arranger` | `{}` | `{}` | yes | no | `back_to_arranger` |
| `capture_midi` | `{}` | `{}` | yes | no | `capture_midi` |
| `trigger_session_record` | `{record_length?: 1..256 beats}`; subject to 5.6 rule 4 | `{}` | yes | no | `trigger_session_record` |
| `re_enable_automation` | `{}` | `{}` | yes | no | `re_enable_automation` |
| `batch` | `{ops:[{cmd,args}] (1..32), stop_on_error?:bool=true}`; `batch`, `catalog`, `undo`, `redo`, `browser_search` are forbidden in ops (`invalid_args`) | `{results:[{ok,result?/error?}], executed:n, partial:bool}` | yes if any op mutates | conditional (if any op is) | per op; one `begin/end_undo_step` pair total |
| (n/a) | `ping`/`pong` frames, section 3.5 | | | | |

`batch` first validates every op's schema statically (types, ranges, forbidden commands). References are NOT resolved up front, because earlier ops change indices: each op's references are resolved at its execution time (clients should use `expect_name`). Edition prechecks use projected counts (current counts plus creations minus deletions of earlier ops). The recording safety rule (5.6) is checked per op. The response is `ok:true` with per-op `results`; when `stop_on_error` stops it at a failing op, the remaining ops are not run and `partial` is true if any earlier op mutated. The envelope is `ok:false` only for batch-level faults (schema, timeout before start).

### 7.2 Tracks (8)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `track_list` | `{include_returns?=true, include_master?=true}` + paging | list of `TrackInfo` | no | no | `tracks`, `return_tracks`, `master_track` + properties |
| `track_get` | `{track, include_clips?:bool=false}` | `{track:TrackInfo, devices:[DeviceInfo], slots:[SlotInfo] or null}` | no | no | `devices`, `clip_slots` |
| `track_create` | `{type:"midi"/"audio"/"return", index?: -1..n (default -1), name?, color?}`; `index` ignored for `return`; `ears_internal?: true` (server-only, reserved) with `name:"batuta-ears"` registers the created audio track as the ears track (5.6); without the flag the script also rejects `name:"batuta-ears"` (`invalid_args`) | `{track:TrackInfo}` | yes | no | `create_midi_track`, `create_audio_track`, `create_return_track` (edition precheck, section 8) |
| `track_delete` | `{track (kind track or return), expect_name?}` | `{deleted:{kind,index,name}}` | yes | yes | `delete_track`, `delete_return_track` |
| `track_duplicate` | `{track (kind track)}`; refused for an external-live track (5.6 rule 6) | `{track:TrackInfo, created:n}` | yes | no | `duplicate_track` (edition precheck on projected count: duplicating a group track also copies its children) |
| `track_set` | `{track, name?, color?, mute?, solo?, arm?, fold_state?, monitoring_state? 0..2}`; master accepts no fields here (`invalid_args`; use `mixer_set` for master volume/pan); `arm` requires `can_be_armed` and is subject to 5.6 rule 1; `monitoring_state` 0 (In) on audio tracks is refused (5.6 rule 2); `name`/`color` not for master | `{track:TrackInfo}` | yes | no | property setters (`monitoring_state` property name [A]) |
| `track_select` | `{track}` | `{selected_track}` | yes | no | `view.selected_track` |
| `track_stop_clips` | `{track (kind track)}` | `{}` | yes | no | `stop_all_clips` |

### 7.3 Mixer and routing (4)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `mixer_get` | `{track}` | `{volume:{value,min,max,display,volume_db}, pan:{...}, sends:[{index,name,value,min,max,display}], track_activator, crossfade_assign, cue_volume?, crossfader?}` (last two master only) | no | no | `mixer_device.*`, `parameters` |
| `mixer_set` | `{track, volume?, volume_db?, pan?, sends?:[{index,value}] (<=12), crossfade_assign? 0..2, cue_volume? (master), crossfader? (master)}`; `volume` and `volume_db` are mutually exclusive; out-of-range gives `out_of_range` (no clamping) | `{mixer: as mixer_get}` | yes | if gain guard trips (9.4) | `volume.value`, `panning.value`, `sends[i].value`, ... |
| `routing_get` | `{track}` | `{input:{type,channel,available_types:[display_name],available_channels:[display_name]}, output:{...}}`; master: `input` is `null` | no | no | `input_routing_type/channel`, `available_*`, `output_*` |
| `routing_set` | `{track, input_type?, input_channel?, output_type?, output_channel?}` display names; applied in order input_type, input_channel, output_type, output_channel; each matched against the current `available_*` objects (no match: `not_found` with the list in `details`; duplicates: `invalid_args`, never auto-picked); an unavailable direction for the track (e.g. master input) is `invalid_args`; subject to 5.6 rule 3 | `{routing: as routing_get}` | yes | no | `*_routing_type`, `*_routing_channel` |

### 7.4 Scenes (7)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `scene_list` | paging | list of `SceneInfo` | no | no | `scenes` |
| `scene_create` | `{index?: -1..n (default -1), name?, color?, tempo?}` | `{scene:SceneInfo}` | yes | no | `create_scene` (edition precheck) |
| `scene_delete` | `{scene, expect_name?}` | `{deleted:{index,name}}` | yes | yes | `delete_scene` |
| `scene_duplicate` | `{scene}` | `{scene:SceneInfo}` | yes | no | `duplicate_scene` (edition precheck) |
| `scene_set` | `{scene, name?, color?, tempo? (20..999 or null=disable), time_signature? ([n,d] or null=disable)}` | `{scene:SceneInfo}` | yes | no | setters on `Scene` |
| `scene_fire` | `{scene, force_legato?=false, can_select_scene_on_launch?=true, as_selected?=false}`; subject to 5.6 rule 4 | `{}` | yes | no | `fire`, `fire_as_selected` |
| `scene_capture` | `{}` | `{scene:SceneInfo}` | yes | no | `capture_and_insert_scene` (edition precheck) |

### 7.5 Cue points (5)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `cue_list` | paging | list of `{index,name,time}` | no | no | `cue_points` |
| `cue_create` | `{time: >=0, name?}`; `invalid_args` if a cue exists within 1e-6 beats of `time` (it would toggle off), or if `is_playing` (`details.reason="transport_running"`) | `{cue:{index,name,time}}` | yes | no | `current_song_time` set (tick 1), read back (it must equal `time` within 1e-6 beats, else `lom_error` `PlayheadNotReached`, nothing toggled), `set_or_delete_cue`, inspect on the next tick (a cue at the wrong time is toggled off again on its own ticks: `lom_error` `WrongCueTime`), `name`; playhead restored on a later tick; not allowed in `batch` |
| `cue_delete` | `{index, expect_time?}` (tolerance 1e-6 beats); `invalid_args` while `is_playing` | `{deleted:{index,name,time}}` | yes | yes | seek to cue time (tick 1) and read it back (`PlayheadNotReached`), `set_or_delete_cue`, inspect on the next tick (`WrongCueRemoved` if another cue went); playhead restored on a later tick; not allowed in `batch` |
| `cue_set` | `{index, name}` | `{cue}` | yes | no | `name` |
| `cue_jump` | `{index}` or `{direction:"next"/"prev"}` | `{current_song_time}` (read one Live tick after the jump; inside `batch` no tick wait) | yes | no | `jump`, `jump_to_next_cue`, `jump_to_prev_cue` |

### 7.6 Clips and notes (17)

Session clips live on `track` kind tracks. `ClipRef` of kind `arrangement` is accepted wherever stated.

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `clip_list` | `{track, include_empty?=false}` + paging | list of `SlotInfo` | no | no | `clip_slots`, `clip` |
| `clip_get` | `{clip}` (either kind) | `{clip:ClipInfo}` | no | no | clip properties |
| `slot_status` | `{track, slot}` | `SlotInfo` incl. `is_recording`, `is_triggered` | no | no | `ClipSlot` properties |
| `clip_create` | `{track, slot, length: 0.25..1024, name?, color?}`; MIDI tracks only; slot MUST be empty (`invalid_args`) | `{clip:ClipInfo}` | yes | no | `ClipSlot.create_clip` |
| `audio_clip_create` | `{track (kind track), slot, file_path}` (session; slot MUST be empty) or `{track, position, expected_length_beats, file_path, allow_overwrite?=false}` (arrangement). `expected_length_beats` is computed by the server from the WAV/AIFF header duration and the tempo; the script rejects overlap with existing arrangement clips over `[position, position+expected_length_beats)` unless `allow_overwrite` (`details.reason="overlap"`). For other formats (.flac, .mp3) the length cannot be known, so the arrangement form is rejected unless `allow_overwrite` is true. Warping can change the resulting length [A37]. The script checks only: absolute, no `..`, no NUL, <= 1024 bytes, extension in {.wav,.aif,.aiff,.flac,.mp3}; command refused with `disabled_by_config` when the connection did not send `allow_audio_import` true (see below) | `{clip:ClipInfo}` | yes | if `allow_overwrite` | `ClipSlot.create_audio_clip` [A], `Track.create_audio_clip` (Live opens the file; the script does not) |
| `clip_delete` | `{clip, expect_name?}` | `{deleted:{name}}` | yes | yes | `ClipSlot.delete_clip`, `Track.delete_clip` |
| `clip_duplicate` | `{from:SlotRef, to?:SlotRef, allow_overwrite?=false}`; without `to` uses `duplicate_clip_slot`, which can create a new scene (edition precheck on scenes); occupied target without `allow_overwrite` is `invalid_args` | `{clip:ClipInfo}` | yes | if `allow_overwrite` | `duplicate_clip_to`, `duplicate_clip_slot` |
| `clip_set` | `{clip, name?, color?, muted?, looping?, loop_start?, loop_end?, start_marker?, end_marker?, gain? (audio), pitch_coarse? -48..48, pitch_fine? -50..50, warping?}`; script orders marker/loop writes to avoid transient invalid ranges and validates `loop_start < loop_end` first | `{clip:ClipInfo}` | yes | no | setters |
| `clip_crop` | `{clip}` | `{clip}` | yes | yes (drops data outside loop) | `crop` |
| `clip_duplicate_loop` | `{clip}` | `{clip}` | yes | no | `duplicate_loop` |
| `slot_fire` | `{track (kind track), slot, record_length?: 0.25..256 beats, launch_quantization?: 0..13}`; on an empty slot of an armed track it records; subject to 5.6 rule 4 | `{}` | yes | no | `ClipSlot.fire` |
| `slot_stop` | `{track, slot}` | `{}` | yes | no | `ClipSlot.stop` |
| `notes_get` | `{clip, from_pitch?=0, pitch_span?=128, from_time? (>= -1e6, default -1e6), time_span? (default 2e6)}` + `limit` (default 1000, max 5000), `offset`; the defaults cover every note, including notes before the start marker and outside the loop; pages are also byte-budgeted (a page stops before ~900 KB encoded and sets `next_offset`) | list of `Note` sorted by `start_time` then `pitch` | no | no | `get_notes_extended` |
| `notes_add` | `{clip, notes:[{pitch,start_time,duration,velocity?=100,mute?=false,probability?=1,velocity_deviation?=0,release_velocity?=64}] (1..2000)}`; MIDI clips only; durations > 0 | `{added:n}` | yes | no | `add_new_notes` |
| `notes_remove` | `{clip, from_pitch?, pitch_span?, from_time?, time_span?}` or `{clip, note_ids:[int] (<=2000)}`; omitted range means everything ("clear notes") | `{removed:n}` | yes | yes | `remove_notes_extended`, `remove_notes_by_id` |
| `notes_modify` | `{clip, notes:[{note_id, ...any Note fields}] (<=2000)}`; unknown `note_id` gives `not_found` | `{modified:n}` | yes | no | `get_notes_by_id` (else `get_notes_extended`), fields set in place on those notes, `apply_note_modifications` with the same vector Live returned (a Python list is rejected by Live) |
| `notes_quantize` | `{clip, grid:"1/4"/"1/8"/"1/16"/"1/32", amount?:0..1=1, pitch?:0..127}`; mapping to LOM enum in script [A] | `{}` | yes | no | `quantize`, `quantize_pitch` |

`audio_clip_create` validation (server, before sending). No configuration is needed. `sample_roots` (config, optional, default empty = no root restriction): when non-empty, each root MUST be an absolute directory owned by the user with no group/other write bit (`lstat`), the file MUST resolve under one of them, and every directory between the root and the file MUST be owned by the user without group/other write. The server requires an absolute `file_path` without NUL (<= 1024 bytes), resolves `realpath(file_path)`, requires the extension allowed, opens with `O_RDONLY|O_NOFOLLOW`, `fstat` regular file owned by the user, `lstat(real)` same `st_dev`/`st_ino`, size <= 1 GiB, and parses the WAV/AIFF header when the extension is .wav/.aif/.aiff. It sends the validated realpath, never the model-supplied string. Side effect to document: Live writes an analysis file (`<name>.asd`) next to imported samples [A], a file write performed by Live next to the imported file, not by BatutaMCP.

### 7.7 Clip envelopes (session clips only) (5)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `envelope_list` | `{clip}`: checks track mixer (volume, pan, sends) and up to 1000 device parameters on the clip's track | `{envelopes:[ParamRef + name]}` | no | no | `automation_envelope` |
| `envelope_get` | `{clip, param:ParamRef, from?=0, to?=clip length, points?: 2..512 =128}` | `{exists, points:[{time,value}]}` | no | no | `automation_envelope`, `value_at_time` |
| `envelope_set` | `{clip, param, steps:[{time,duration,value}] (1..1024), replace?=false}`; times within clip length; values within param min/max | `{inserted:n}` | yes | if `replace` | `create_automation_envelope`, `clear_envelope`, `insert_step` |
| `envelope_clear` | `{clip, param}` | `{}` | yes | yes | `clear_envelope` |
| `envelope_clear_all` | `{clip}` | `{}` | yes | yes | `clear_all_envelopes` |

Arrangement clips: automation envelopes are not supported (`not_supported`, `details.reason="arrangement"`).

### 7.8 Devices and parameters (7)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `device_list` | `{container: ContainerRef}` (required; `{container:{track,path:[]}}` lists the track's own chain) + paging | list of `DeviceInfo` | no | no | `devices`, `chains[i].devices` |
| `device_get` | `{device, limit?<=128=128, offset?}` | `{device:DeviceInfo, parameters:[ParamInfo], total, next_offset}` | no | no | `parameters`, `str_for_value` |
| `param_get` | `{param, at_value?}`; with `at_value` the result adds `display_at_value` = `str_for_value(at_value)` (read-only; used by the gain guard) | `ParamInfo` (+ `display_at_value`) | no | no | `DeviceParameter`, `str_for_value` |
| `param_set` | `{device, items:[{index,value}] (1..64)}` or `{param, value}`; `value` MUST be within `[min,max]`; quantized params require an integer index; disabled params (`is_enabled` false) give `invalid_args` | `{params:[ParamInfo]}` | yes | if gain guard trips (9.4) | `value` setter |
| `device_enable` | `{device, enabled}`: sets the parameter named "Device On" (index 0) | `{device:DeviceInfo}` | yes | no | `parameters[0].value` |
| `device_delete` | `{device, expect_name?}` | `{deleted:{name}}` | yes | yes | `Track.delete_device` (chain level [A]) |
| `device_insert` | `{container: ContainerRef, name, index?=-1}`; `name` matches `^[A-Za-z0-9 '&()+./-]{1,64}$`; built-in names only; `External Audio Effect`, `External Instrument` (unless `allow_external_devices`) and Max for Live names (unless `allow_max_for_live`) are refused before the call (`not_supported`, `blocked_content`); after the call the new device tree is checked and a Max (unless allowed), External* (unless allowed) or plugin device is removed again and the call fails (7.10 cleanup); Live rejects unknown names (`not_found`) | `{device:DeviceInfo}` | yes | no | `Track.insert_device`, `Chain.insert_device` [A] (12.3+) |

### 7.9 Racks and drum pads (8)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `rack_get` | `{device}` | `{chains:[{index,name,color,mute,solo,device_count,volume,pan}], return_chains:[...], macro_count, variation_count, selected_variation, can_have_drum_pads}` | no | no | `chains`, `return_chains`, `variation_count`, `selected_variation_index` |
| `chain_set` | `{device, chain:{kind:"chain"/"return_chain",index}, name?, color?, mute?, solo?, volume?, volume_db? (exclusive with volume, so the server can apply the gain guard), pan?}` | `{chain}` | yes | if gain guard trips on `volume`/`volume_db` (9.4; a raw chain `volume` is unparsable for the guard and trips it) | `Chain` setters, `mixer_device` |
| `rack_insert_chain` | `{device, index?=-1}` [A] | `{chain}` | yes | no | `insert_chain` (12.3+) |
| `rack_variation` | `{device, action:"store"/"recall"/"delete"/"randomize", index?}` (`recall`/`delete` need `index` 0..variation_count-1) | `{variation_count, selected_variation}` | yes | if `delete` | `store_variation`, `recall_selected_variation`, `delete_selected_variation`, `randomize_macros` |
| `drum_pads_list` | `{device, all?=false}` (default: pads with chains) | list of `{note,name,mute,solo,chain_count}` | no | no | `drum_pads` |
| `drum_pad_set` | `{device, note:0..127, mute?, solo?}` | `{pad}` | yes | no | `DrumPad` setters |
| `drum_pad_copy` | `{device, from_note, to_note}`; overwrites target | `{pad}` | yes | yes | `copy_pad` |
| `drum_pad_clear` | `{device, note}` | `{}` | yes | yes | `delete_all_chains` |

### 7.10 Browser (3)

Categories: `instruments, drums, sounds, audio_effects, midi_effects, packs, user_library, samples, current_project, plugins` (this list is exhaustive). `max_for_live` is served only when the connection's `allow_max_for_live` (hello) is true: items there are classified like any other (devices and `.amxd` loadable, folders browsable, `browser_search` includes it); otherwise `browser_list`/`browser_search` on it return `not_supported` (`blocked_content`). `plugins` is served only when the connection's `allow_plugins` (hello) is true, else `not_supported` (`disabled_by_config`). Absent categories return `not_supported`. Categories not named above (including `modulators`) are never served: `not_supported` (`blocked_content`). Every returned item is classified by its category, its SOURCE and its URI (below); the classification is stored in the URI map entry.

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `browser_list` | `{category, path?:[names] (<=8)}` + `limit` (default 100, max 200) | `{items:[{name,uri,is_folder,is_loadable,is_device,blocked}], total, next_offset}`; `blocked` is null or `max_for_live`/`live_set`/`plugin`/`external_device`/`user_content`; blocked items are always `is_loadable:false` | no | no | `Browser` category attributes, `children` |
| `browser_search` | `{query: 1..64 chars, category?, loadable_only?=true, limit?<=50=25}`; BFS visiting <= 3000 nodes, case-insensitive substring on `name`; never inside `batch`; same blocking as `browser_list` | `{items:[{name,uri,path,is_loadable,blocked}], truncated:bool, visited:n}` | no | no | `children` traversal |
| `browser_load` | `{track (kind track, return or master), uri}`; the script sets `view.selected_track` to the target, verifies it was actually selected (otherwise `not_supported`, `reason:"selection_failed"`, before `load_item`), loads, and restores the previous selection on every path; a deferred sweep also watches the restored previous selection (when it differs from the target) for new offending devices at its insertion point [A: an instrument loaded onto master or a return is expected not to land → `verified:false`/`sweep_pending`]; `uri` MUST come from `browser_list`/`browser_search` earlier in the SAME connection (script keeps an LRU map uri to item and classification, 5000 entries, cleared on disconnect); allowlist below; anything else `not_supported` (`blocked_content`) | `{loaded:{name,uri}, device_count}` | yes | no | `view.selected_track` set and restored, `load_item` |

`browser_load` allowlist. Classification uses the category the item was reached from and the extension of the URI's last path segment (percent-decoded). The display name only ADDS blocks (a name spelling `.als`, `.amxd`, Max for Live, an External device or a plugin extension is blocked whatever the URI says; `.amxd` and Max for Live names are not blocked with `allow_max_for_live`, External device names are not blocked with `allow_external_devices`, and `.als` never) and, when the URI's last segment has no extension at all, supplies the extension: Live 12.4.7 gives items reached through `sounds`, `drums` and `samples` opaque URIs such as `query:Sounds#Bass:FileId_24509` (name `808 Pure.adg`), so those are classified by the name's extension; no extension in either is `user_content`. A folder Live reports as not loadable shows `blocked: null` unless a real block applies; loading a folder is impossible either way:

- Allowed without opt-in: (1) native devices (`is_device`) in `instruments`, `drums` (the Drum Rack), `audio_effects`, `midi_effects`; (2) FACTORY content, decided by SOURCE, not by category: only items whose URI source identity proves Core Library content (the exact URI marker is [A39]) are factory, and then only inside `sounds`, `drums`, `instruments`, `audio_effects`, `midi_effects` (racks, kits, presets `.adg`, `.adv`, `.alc`); (3) audio samples (.wav .aif .aiff .flac .mp3 .ogg .m4a) from any served category. Fail closed: if the source cannot be proven to be the Core Library, the item is not factory. Installed Packs reached through the `sounds`, `drums`, `instruments` or effects views are therefore NOT factory.
- Unless `browser.allow_user_presets` is set to `false` (hello `allow_user_presets`; the server default is true so that factory presets Live lists as plain files load without configuration; the script itself treats a missing flag as false): every preset (`.adg`, `.adv`, `.alc`) that is not proven Core Library, wherever it is reached: `user_library`, `packs`, `current_project`, and Pack or user content shown inside `sounds`, `drums`, `instruments`, `audio_effects`, `midi_effects`. Documented risk: such presets are third-party or user content and can contain Max for Live or plugin devices; the post-load cleanup below reduces but does not remove that risk.
- Only with `browser.allow_plugins: true`: the `plugins` category.
- Only with `browser.allow_max_for_live` (hello `allow_max_for_live`, server default true; the script treats a missing flag as false): `.amxd` files, Max for Live names and sources, and the `max_for_live` category. Stock Suite M4L devices (DS Kick, LFO, Envelope Follower, ...) are listed loadable and load with their real `class_name`; they are not swept. Presets containing them follow the preset rule above.
- External Audio Effect / External Instrument items [A38] load only with `browser.allow_external_devices` (default true); they are not swept, also inside racks. Recording with them live asks the owner (5.6).
- Never: `.als` (Live sets) and anything unclassifiable.

Post-load cleanup: the script snapshots the track's device tree before `load_item` and afterwards walks the whole tree (devices, chains, return chains, drum pads, depth <= 8, <= 500 devices). Any NEW Max for Live device (`class_name` starting with `Max`, unless `allow_max_for_live`), plugin device (unless `allow_plugins`) or External* device (unless `allow_external_devices`) is deleted with `delete_device` (if chain-level deletion is unavailable [A11], the whole new top-level device is deleted) in the same handler, and the call fails with `not_supported` (`blocked_content`, `details.partial=true`). This is cleanup only: it cannot stop code that already ran while the item loaded. The selected track is restored in all paths. Whether `load_item` is synchronous, where it places the device (end of chain or instrument replacement), and whether Suite factory racks can contain Max for Live devices (which would make some factory loads refuse) are unverified [A23] [A36].

Loading a Drum Rack onto a track that already holds one (Live 12.4.7 Lite, F-T9-20): Live shows no change (same device count, nothing new), so the load is reported `verified:false`, `sweep_pending:true` and the sweep ends in `timeout`; until then every further `browser_load` on that track is refused `busy` (`reason:"sweep_pending"`). The script is left as it is: a "same class and name counts as landed" rule would also hide a real silent failure and could not tell a replaced rack from an untouched one, and the Max for Live cleanup depends on the same change detection. The `load_drum_kit` composite avoids the case (a top-level `DrumGroupDevice` instrument already on the track skips the rack load, reported as `rack_load: {skipped:true, reason:"drum_rack_present"}`) and, when its own rack load is still being swept, retries the kit load a bounded number of times; if the sweep has not finished it fails `busy` with `details.rack_loaded:true` and a message to call the tool again.

Tracks Live creates during a load (observed on Live 12.4.7 Lite: the native Drum Rack onto an audio track makes a new armed MIDI track holding it): the result adds `new_tracks: [{kind:"track", index, name, arm}]` and `landed_on: {kind:"track", index}` (the first new track, i.e. where the item went instead of the target). Both fields are omitted when no track appeared, so existing fields are unchanged. The same two fields are added to the sweep outcome (`recent_sweeps` / `previous_sweep`) when a track appears only during the deferred sweep. The script never deletes or disarms the new track (owner decision: report); the server adds a warning.

### 7.11 Arrangement (4)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `arrangement_clips` | `{track, from?, to?}` + paging | list of `{index,name,start_time,end_time,length,loop_length,is_midi,is_audio}`; `length` = timeline extent (`end_time - start_time`), `loop_length` = Live's `clip.length` | no | no | `arrangement_clips` |
| `arrangement_clip_create` | `{track (midi), start: >=0, length: 0.25..4096, name?}`; overlap with existing clips is `invalid_args` | `{clip:ClipInfo}` | yes | no | `create_midi_clip` |
| `arrangement_duplicate` | `{source:ClipRef, track, time: >=0, allow_overwrite?=false}`; the script computes overlap with existing arrangement clips on `track` over `[time, time+length)`; overlap without the flag is `invalid_args` (`details.reason="overlap"`); Live leaves the playhead at the destination, so the script restores it afterwards (on a later tick at top level, at once inside `batch`, not while playing) | `{clip:ClipInfo}` | yes | if `allow_overwrite` | `duplicate_clip_to_arrangement` |
| `arrangement_commit_scene` | `{scene, time: >=0, tracks?:[TrackRef (kind track)], allow_overwrite?=false}`: copies the scene's session clips to the arrangement at `time` ("capture session to arrangement"); pre-validates all targets; one undo step | `{clips:[ClipInfo], skipped:[TrackRef]}` | yes | if `allow_overwrite` | `duplicate_clip_to_arrangement` per track |

Deleting, renaming, recoloring arrangement clips: `clip_delete`, `clip_set`, `clip_get` with `ClipRef.kind = "arrangement"`.

### 7.12 Ears support (0 new script commands)

Ears composes existing commands: `song_info`, `track_list`, `track_create`, `routing_get`, `routing_set`, `track_set`, `batch`, `transport`, `slot_fire`, `slot_status`, `clip_get` (`file_path`), `slot_stop`, `song_set_time`, `track_delete` (with `expect_name`). Flow in section 10. The script never reads or opens the recorded file.

### 7.13 Undo and redo (3)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `undo_state` | `{}` | `{can_undo, can_redo}` | no | no | `can_undo`, `can_redo` |
| `undo` | `{steps?: 1..10 = 1}`; stops early when `can_undo` is false | `{undone:n, can_undo, can_redo}` | yes (not wrapped) | if `steps` > 1 | `undo` |
| `redo` | `{steps?: 1..10 = 1}` | `{redone:n, can_undo, can_redo}` | yes (not wrapped) | no | `redo` |

### 7.14 Meters (1)

| Command | Args | Result | M | D | LOM |
|---|---|---|---|---|---|
| `meters_get` | `{tracks:[TrackRef] (1..32)}` or `{all:true}` | `{meters:[{track:TrackRef, left, right, level}]}` | no | no | `output_meter_left/right/level` |

Meters are peak-smoothed UI values: liveness and rough clip detection only, never loudness.

### 7.15 Catalog totals and exclusions

Totals: session/meta 11 (incl. `batch`, `catalog`), tracks 8, mixer/routing 4, scenes 7, cues 5, clips/notes 17, envelopes 5, devices 7, racks/drum pads 8, browser 3, arrangement 4, ears 0, undo/redo 3, meters 1, views 3 (`view_show`, `view_focus`, `view_get`; UI only, mutating false, never destructive, no undo step, allowed in `batch`; views: session, arrangement, detail_clip, detail_device, browser) = 86 commands.

NOT provided by the Remote Script and MUST NOT be added there: saving or exporting a set, opening sets or loading `.als`, loading Max for Live (`.amxd`) in any way, any file write, subprocess or shell, generic property get/set, `getattr`-style access, recording from audio interfaces or microphones (see 5.6), dataset/telemetry tools, UI automation beyond `track_select` and the `view_*` commands. Owner decision 2026-10-27: launching Live, new set, open, save, save as and the export dialog ARE provided, but only by the server's isolated host-automation module (`docs/04-host-automation.md`, T5c-3), never by the script; loading Max for Live and microphone recording stay excluded everywhere. `audio_clip_create` is the only path-bearing arg and asks Live to import one audio file from a validated root.

### 7.16 MCP tool surface (T5)

| Item | Rule |
|---|---|
| Naming | Public snake_case names (verb_object, compatibility names where they exist) listed in `docs/03-tool-names.md`; one broad tool per command plus thin aliases and server-side composites; only `batuta_confirm`, `batuta_status` and `batuta_ears` keep the prefix. Wire commands keep the catalog names. Tool names, descriptions and schemas are static; they never embed strings read from Live |
| Not exposed | `catalog` (internal startup check); the `ears_internal` arg of `track_create` and the reserved name `batuta-ears` (rejected by `batuta_track_create` and by `batuta_track_set` renames) |
| Exposed with changes | `batuta_batch`: ops carry refs only (indices plus `expect_name`). One rule: the server resolves every name selector BEFORE sending, with a fresh listing, and a name selector inside a batch op is converted to a ref at that time; the script never resolves names. Earlier ops that change indices are the client's responsibility, which `expect_name` makes fail safely |
| Server-only tools | `batuta_confirm` (section 9.3), `batuta_ears` (section 10), `batuta_status` (connection state, protocol, `script_version`, edition and source, effective config summary; uses the cached welcome, no script call) |
| Count | About 131 tools (see `docs/03-tool-names.md`), incl. the server-only host tools `launch_live`, `open_set`, `new_set`, `save_set`, `save_set_as`, `export_audio` (no script command; listed only with `host.enabled` on macOS; errors `permission_required` (detected by error number: -25211/-1719 Accessibility, -1743 Automation) and `host_failed` (reasons incl. `path_not_applied`, `replace_unverified`, `save_unverified`, `stat_failed`), `invalid_args` path reasons incl. `symlinked_parent`, `hardlinked_file`, `target_changed`, plus new `not_supported` reasons, docs/04-host-automation.md §errors; config `host.enabled`, `host.live_app`, `host.set_roots`, config file only); `tools/list` page size 200 so the whole surface fits one page. Fewer when `destructive: "disabled"` (tools whose classification is `always` are omitted), `sample_roots` is empty (`audio_clip_create` omitted), or `ears.enabled` is false |
| Selectors | Tool schemas accept, wherever section 6.1 needs a ref, either the ref or a name selector: `TrackSel = TrackRef / {"name":string}`; `scene = int / {"name":string}`; device path hops `int / {"name":string}`; `ParamSel = {"index":int} / {"name":string}`. The server resolves names to indices with fresh listings (6.1) and always sends refs with `expect_name`. The script never sees names as selectors |
| Annotations | `readOnlyHint` true when M is no; `destructiveHint` true when classification is `always` or `conditional`; `idempotentHint` true for pure setters; `openWorldHint` false |
| Results | Structured JSON equal to the script result plus a short text rendering. Live-sourced strings are capped at 128 chars and control-stripped. Errors: MCP `isError:true` with `{code,message,details}`; the text is `code: message`, then (when there are details; not for `invalid_args`, whose message lists its issues) a second line with the compact JSON `{"details":{...}}` (at most 500 characters; over that only short scalar entries are kept) so clients that show only the text still see for example `resource`, `limit`, `current`, `edition` of `edition_limit` or the `reason` of `not_supported`. The first line is always `code: message` |

### 7.17 MCP App: transport panel

Hosts that implement the MCP Apps extension (`io.modelcontextprotocol/ui`, spec 2026-01-26; Claude Desktop, ChatGPT) can render an interactive transport panel inline in the chat.

| Item | Rule |
|---|---|
| Tool | `show_transport_panel` (no arguments, read-only). It runs `get_transport` and returns its normal text and `structuredContent`, so hosts without MCP Apps (Claude Code, other CLIs) get a complete text answer. Its listing carries `_meta.ui.resourceUri` and `_meta["openai/outputTemplate"]`, both `ui://batuta/transport-panel-v3.html`. No other tool carries `_meta` |
| Resource | `ui://batuta/transport-panel-v3.html`, mime type `text/html;profile=mcp-app`, served by `resources/list` (exactly this one) and `resources/read` (`_meta.ui.prefersBorder: true`, no `csp`, so the spec default applies: inline script and style, no network). `resources/templates/list` is empty; an unknown URI is JSON-RPC error -32002. The server advertises `capabilities.resources: {}`; `resources/*` need an initialized session like `tools/*` |
| Page | One HTML string compiled into the server (`server/src/ui/transport-panel.ts`): no dependency, no external URL or file, no `fetch`, WebSocket, `eval` or `innerHTML`. It accepts messages only from `window.parent` and only well-formed JSON-RPC 2.0; requests time out after 8 s; timers stop on `ui/resource-teardown` |
| Calls | Through the host, with `tools/call`: `get_transport` (poll every 1 s playing, 4 s stopped, 5 s while Live is not connected), `control_transport` `{action: "start" \| "stop"}`, `set_song_position` `{beats}`. Buttons: back to start (0), back a bar (to the current bar line when more than 0.01 beat past it, else one bar earlier, never below 0), one play/stop toggle (▶ while stopped, ⏹ while playing; it sends `start` or `stop` from the last known state), forward a bar (next bar line), shown as the symbols ⏮ ⏪ ▶/⏹ ⏩, each followed by the text variation selector U+FE0E and set in a symbol-capable font stack with `font-variant-emoji: text` so Desktop does not draw emoji boxes. The page declares `appCapabilities.availableDisplayModes: ["inline", "pip"]` in `ui/initialize`, keeps `displayMode` and `availableDisplayModes` from the host context (and from `ui/notifications/host-context-changed`), and shows a float button (⧉) only when the host offers `pip` and the panel is not in it, and a dock button (⤓) only while in `pip` when the host offers `inline`; a press sends `ui/request-display-mode` `{mode}` and adopts the mode in the reply (errors and timeouts change nothing). A bar is `numerator * 4 / denominator` beats; bar and beat are counted from 1 as Live shows them |
| Not connected | An `isError` result or a JSON-RPC error from `get_transport` shows "Live not connected", disables the buttons and keeps probing every 5 s |

## 8. Edition limits

| Edition | Tracks (audio+MIDI) | Scenes | Returns |
|---|---|---|---|
| lite | 8 | 16 | 2 |
| standard / suite | unlimited | unlimited | 12 |

- Edition source: (1) script detection from the Live version string (`Live.Application.get_application().get_version_string()` contains "Lite") [A3, verified false on Lite 12.4.7]; (2) `edition_hint` in `hello`, sent by the server from config `edition: "auto"/"lite"/"standard"/"suite"` (env `BATUTA_EDITION`); with `auto` and the host enabled, the server sends the edition of the one running Live 12 app (host probe, same running check as the UI tools, 2 s bound, no app started; zero or two running apps, or a failed probe, send no hint); (3) `unknown`. A config value other than `auto` wins over detection on the server side; in the welcome, detection wins over the hint unless detection is `unknown`.
- Precheck, in both layers (script when edition known, server when its effective edition is known), before `track_create`, `track_duplicate` (projected count: a duplicated group track also copies its children, so `current + 1 + children`), `scene_create`, `scene_duplicate`, `scene_capture`, `clip_duplicate` without `to` (`duplicate_clip_slot` may append a scene), each op of `batch` (projected counts), and the ears temp track: compare counts to the limit; if exceeded return `edition_limit` with `details = {"resource":"tracks"/"scenes"/"returns","limit":8,"current":8,"edition":"lite"}`. Consuming the last free slot (limit-1 current) is allowed.
- `unknown`: no precheck; LOM exceptions are mapped to `lom_error` with `details.suspected = "edition_limit"` when the message mentions limit/maximum/Lite [A].
- Max for Live loads by default in every edition that has it (7.10, `browser.allow_max_for_live`); on Lite it does not exist at all.

## 9. Destructive actions (MCP layer)

### 9.1 Definition

A command call is destructive when the catalog says so (column D, including conditions) or when it cannot be reverted by one `undo`. Classification values: `never`, `conditional`, `always` (ordered by strictness). This covers: all `*_delete` commands, `notes_remove`, `clip_crop`, `envelope_clear`, `envelope_clear_all`, `envelope_set` with `replace`, `rack_variation` delete, `drum_pad_copy`, `drum_pad_clear`, `clip_duplicate`/`arrangement_duplicate`/`arrangement_commit_scene`/`audio_clip_create` with `allow_overwrite`, `undo` with `steps` > 1, calls tripping the gain guard (9.4: `mixer_set`, `param_set`, `chain_set` volume), and any `batch` containing one. The server holds its own table; at startup it reads `catalog` and uses the stricter of both classifications per command. A command absent from the server table but present in the script catalog is treated as `always` and not exposed until reviewed.

### 9.1a Confirmation policy (owner decision 2026-10-27)

The owner does not want to be asked about routine work. Classification (9.1) stays as is (it drives annotations and `disabled` mode), but WHEN the user is asked is governed by `confirm`:
- `confirm: "irreversible"` (default): ask only for (a) actions Live's undo cannot reverse — host actions: only `save_set_as` onto an existing file (`new_set` and `open_set` are protected by Live's own save-changes dialog, `export_audio` only opens a dialog; in `confirm:"destructive"` `open_set` and `new_set` also ask; with `destructive:"disabled"` `save_set_as` onto an existing file is refused), and `undo`/`redo` called by the model (any `steps`: Live's undo stack also holds the owner's manual edits, and any later change drops the redo stack, so a model undo can erase the owner's work for good) — and (b) gain guard trips (9.4, hearing and monitor protection). Every other destructive command (deletes, notes_remove, crop, envelope clears, overwrites, `batch` containing them) runs without a prompt, because each script mutation is exactly one Live undo step; the result says `undoable: true` and `revert: "Cmd-Z in Live, or the undo tool"` (for `undo` itself the hint says redo). A confirmation summary whose destructive or gain-trip lines alone exceed 500 characters is refused with `too_large`.
- `confirm: "destructive"`: the stricter behavior — ask for every destructive classification (9.1).
- `destructive: "disabled"` remains the hard stop and wins over `confirm`.

### 9.2 Config

`destructive: "confirm"` (default) or `"disabled"` (env `BATUTA_DESTRUCTIVE=confirm/disabled`). When `disabled`, tools classified `always` are not listed in `tools/list`; conditional variants (`allow_overwrite`, `replace`, `steps` > 1, gain guard trips) are rejected with `not_supported` (`details.reason="disabled_by_config"`, or `gain_limit` for the gain guard) and no request reaches the script. The only exception is the internal ears cleanup (9.3 item 4), which works in both modes.

### 9.3 Confirmation

1. If the client declared the `elicitation` capability at `initialize`: send `elicitation/create` with `message` = server-generated summary (built from structured fields, names truncated to 64 chars, <= 500 chars total, never raw model text) and schema `{confirm: boolean}`. Proceed only when `action = "accept"` and `confirm = true`. `decline`/`cancel` returns a normal result `{"cancelled": true}`. Elicitation is a UX aid (hooks can auto-answer), not a security boundary.
2. Otherwise two-step token with a dedicated tool:
   - First call of the destructive tool (no extra arg) does not execute. It stores in memory `{cmd, resolved args, summary, expiry}` keyed by `confirm_id`, plus `sha256(canonical(cmd + resolved args))` used only to de-duplicate: a repeated identical first call within the TTL replaces the earlier pending entry, so one distinct operation has at most one pending id. It returns `{"confirmation_required": true, "confirm_id": "<22-char base64url of 16 random bytes>", "summary": "<text>", "expires_in": 60, "next": "call batuta_confirm"}`. canonical = JSON with keys sorted recursively, no whitespace, UTF-8, integers without fraction.
   - Second step is the tool `batuta_confirm {confirm_id, summary}`. `summary` MUST equal the stored text exactly, so the client's approval prompt (which shows tool arguments) displays what will run. The server checks expiry (monotonic clock, 60 s) and single use, then executes the STORED command and args (never anything supplied in the second call) and deletes the entry. Failures are `invalid_args` with `details.reason` in `confirm_unknown`, `confirm_expired`, `confirm_summary_mismatch`, `confirm_used`; 3 failures on one id invalidate it.
   - State is in memory only, max 32 pending (oldest evicted), cleared on server exit.
3. Honest limit: a model can call `batuta_confirm` itself. Because it is a separate tool, users can keep it on "ask" in their client permissions while other tools are allowed, and the prompt then shows the summary; choosing "always allow" for `batuta_confirm` removes that gate, and the README MUST say so. The hard stop is `destructive: "disabled"`.
4. Internal exemption: only the ears cleanup may call `track_delete` without confirmation, and only for the temp track the same process created, with `expect_name = "batuta-ears"` (section 10.7). It bypasses the confirmation AND the `destructive: "disabled"` filter, because leaving the temp track behind is the worse outcome.

### 9.4 Gain guard (loudness harm)

Config: `gain_guard.max_jump_db` (default 6.0) and `gain_guard.max_master_db` (default 0.0), env `BATUTA_MAX_JUMP_DB`, `BATUTA_MAX_MASTER_DB`. Applies in the server to: `mixer_set` volume (any track, return, master; sends excluded), `chain_set` volume, and `param_set` on parameters whose `display` ends with "dB" and whose name matches `/gain|volume|level|output|makeup/i` or is a default rack macro name `/^Macro \d{1,2}$/`. Current dB comes from `mixer_get`/`param_get` display; target dB from `volume_db` or from `param_get {at_value}` (`display_at_value`). Trip when the increase exceeds `max_jump_db`, when the master volume target exceeds `max_master_db`, or when a dB value cannot be parsed. A trip makes the call conditionally destructive (confirmation, 9.3) or, with `destructive: "disabled"`, `not_supported` (`gain_limit`). Decreases never trip. The master ceiling also applies to dB gain parameters on devices in the master track's chain (e.g. Utility Gain) and to the master `cue_volume`. In `batch` the jump limit is measured against each target's level before the call (a single call may raise one target by at most `max_jump_db` in total, however it is split), and any gain-checked op after an op that can shift indices (`track_create`, `track_duplicate`, `track_delete`, `device_insert`, `device_delete`, `browser_load`, `scene_*` create/duplicate/delete) trips. Every index ref the server resolves for a mutating op gets an auto-filled `expect_name` from the listing (the model's value, if any, must match it). Not covered (documented limitation): gain changes through clip envelopes, loaded presets and device parameters not matching the pattern. Tests: jump of 7 dB trips, 5 dB does not, master +1 dB trips, decrease passes, unparsable display trips.

## 10. Ears flow (T7)

Goal: measure a track or the master by recording it inside Live, without plugins, Max, or microphone.

### 10.1 Inputs and config

Tool args: `source` (TrackRef, kind track/return/master), `beats` (1..64, default 16). Config: `ears.enabled` (default true), `ears.max_bytes` (default 268435456 = 256 MiB, hard max 1 GiB), `ears.max_beats` 64, `ears.roots` (extra allowed directories for the Temporary Folder, default none), `ears.set_roots` (extra directories under which a `Samples/Recorded` folder is accepted, e.g. `/Volumes/Music`; default none), one ears job at a time (mutex; a second call gets `busy`, `details.reason="job_running"`).

### 10.2 Steps

0. Preconditions: connected, ears enabled, no job running, no track named `batuta-ears` present (otherwise `invalid_args`, hint: delete the stale track manually), `song_info` shows `record_mode` and `session_record` false (else `not_supported`, `reason:"record_mode_on"`), and no external-live track exists anywhere in the set (5.6 rule 5; else `not_supported`, `reason:"external_input_live"`).
1. `song_info` and `track_list`: record `was_playing`, `current_song_time`, `tempo`, `selected_track`, `armed_before` (tracks with `arm` true), counts. Warnings (continue): the source is muted, or any track is soloed and the source is not (the Post Mixer tap may be silent [A]); added to the report `warnings` as `source_muted` / `solo_active`.
2. Precheck a free track slot: Lite with 8 tracks gives `edition_limit` (`resource:"tracks"`). Verify the source exists and `expect_name` matches.
3. `track_create {type:"audio", name:"batuta-ears", index:-1, ears_internal:true}`. Note `ears_track` (a TrackRef).
4. `routing_get` on the temp track. Choose input: source kind `track` or `return`: `input_type` equals the source's routing display name (for returns the listed form such as "A-Name" [A]); if two available types share that display name, abort with `invalid_args` (ambiguous; the script never picks one). `input_channel = "Post Mixer"` (fallback order: "Post Mixer", "Post FX"; if neither exists, abort `not_supported`). Source `master`: `input_type = "Resampling"`, channel left at default. Apply with ONE `routing_set` (type and channel). If the source's type is not listed (e.g. not available in Lite [A]) abort `not_supported`. The resulting input MUST classify SAFE by object (5.6), otherwise the arm in step 5 is refused.
5. Silence and arm in ONE `batch`: `track_set {mute:true, monitoring_state:2}` and `track_set {arm:true}` (allowed only because this is the ears track, 5.6 rule 1; one undo entry). Before the batch, best effort `routing_set {output_type:"No Output"}`; `not_found` is ignored. Recording is not affected by mute or output [A]. Arming may disarm other tracks if Live's exclusive-arm option is on [A]; they are restored in step 10.
6. If not playing: `transport {action:"start"}`.
7. `slot_fire {track: ears_track, slot: 0, record_length: beats, launch_quantization: 0}` [A: 0 means none].
8. Poll `slot_status` every 250 ms. Done when `is_recording` is false, `is_triggered` is false and `has_clip` is true. Deadline = `beats * 60 / tempo * 1.5 + 5` s, capped at 300 s. Timeout: go to cleanup, error `timeout` (`details.stage="recording"`).
9. `clip_get {clip: {kind:"session", track: ears_track, slot: 0}}` gives `file_path`, `length`, `sample_rate`. Validate the path (10.5), then wait for finalization: `fstat` the open fd every 200 ms until two consecutive sizes are equal and the size is consistent with the header's declared data length, max 5 s (else `timeout`, `details.stage="finalize"`) [A: the file can still grow after `is_recording` turns false].
10. `slot_stop`, then restore: `track_select` back to the original if changed; re-arm the `armed_before` tracks that were disarmed (best effort via `track_set`; refusals under 5.6 are reported as warnings). If `was_playing` was false: `transport stop` and `song_set_time` back to the recorded `current_song_time`. If it was playing, the playhead is NOT moved (playback continued through the recording).
11. Analyze (10.6) and report.
12. Cleanup (always, in `finally`, 10.7).

Total job deadline: 600 s. MCP cancellation aborts immediately into steps 10 and 12.

### 10.3 Side effects the owner must expect

Real-time capture (duration = beats at current tempo); one track slot used briefly; the set becomes modified; the undo stack gains one entry per step that is not batched (create, routing, silence-and-arm batch, record, stop, optional transport, delete: about 6 to 8 entries), so the owner must not press Undo blindly afterwards; the source plays through the master normally; the temp track is muted so nothing doubles.

### 10.4 Failure and abort

Any error at steps 3 to 11 jumps to cleanup. If the script connection is lost mid-job, the server reconnects (up to 30 s) and runs cleanup; if that fails it returns error code `cleanup_failed` with the exact manual instruction ("delete the track named batuta-ears") in `details.manual`. The Remote Script never cleans up on its own and never deletes files.

### 10.5 File validation (server, before reading)

All MUST hold, else error `invalid_args` (`details.reason`) and no analysis:
1. `file_path` is a string, absolute, <= 1024 bytes, no NUL.
2. `real = fs.realpath(file_path)`; `real` starts with a root plus separator. Allowed roots: Live's Temporary Folder (default location [A], config `ears.roots` to add), or a directory whose last two components are `Samples/Recorded` located under the user's home directory or under one of `ears.set_roots` (for sets on external volumes).
3. Extension (lowercase) in `.wav`, `.aif`, `.aiff`.
4. Open with `O_RDONLY|O_NOFOLLOW`; `fstat` on the fd: regular file, `st_uid` = current uid, `st_nlink` = 1, `44 < st_size <= ears.max_bytes`. Node cannot recover a path from an fd on macOS, so require `lstat(real)` to report the same `st_dev` and `st_ino` as `fstat(fd)`, checked after the open and again after finalization. All reading uses this fd (no second open).
5. Header parse (RIFF/WAVE PCM or float, AIFF/AIFC): channels 1..2 [A: or up to 8, downmix rejected], sample rate 8000..384000, bit depth 16/24/32 (int) or 32/64 (float); duration <= 300 s. Malformed gives `invalid_args`.

### 10.6 Analysis and report

BS.1770-5 / EBU R128 per `docs/00-research.md`. Report (all numbers rounded to 0.1 dB unless noted; `null` plus a `warnings` entry when undefined):

| Field | Meaning |
|---|---|
| `duration_s`, `sample_rate`, `channels`, `bit_depth` | File facts |
| `integrated_lufs` | Gated I (needs >= 400 ms) |
| `short_term_max_lufs` | Max of 3 s windows (needs >= 3 s), hop 100 ms |
| `momentary_max_lufs` | Max of 400 ms windows, hop 100 ms |
| `lra_lu` | EBU Tech 3342 (needs >= 3 s of gated content) |
| `true_peak_dbtp` (+ per channel) | 4x oversampled max (2x if rate >= 96 kHz, none >= 192 kHz) |
| `sample_peak_dbfs` | Max absolute sample |
| `rms_dbfs` | RMS of all samples (unweighted) |
| `crest_db` | `sample_peak_dbfs - rms_dbfs` |
| `spectrum` | Octave bands centered at 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz (edges fc/sqrt2 to fc*sqrt2; bands above Nyquist are `null`): FFT 8192, Hann window, 50 % overlap, power averaged over frames and channels (mean of per-channel spectra); estimate S_k = abs(X_k)^2 / (N * sum(w^2)), one-sided (x2 for 0<k<N/2); band level = 10*log10(sum of S_k in band / 0.5), so a full-scale sine reads 0 dB in its band (0 dBFS reference = full-scale sine, mean square 0.5) |
| `correlation` | Pearson L/R over the file, -1..1 (`null` for mono) |
| `warnings` | e.g. silence, clipping (sample peak >= 0 dBFS), too short for LRA |

Mono files: loudness uses the single channel with weight 1.0 (no +3.01 dB dual-mono compensation) and the report sets `mono: true`; sample peak, true peak and RMS use that channel; `correlation` is `null`. Stereo uses L/R weights 1.0, no surround weights.

### 10.7 Cleanup (always)

1. Fresh `track_list`; find the track whose name is `batuta-ears` that this job created (index must match the recorded `ears_track` or be the only match); otherwise do nothing and warn.
2. `track_delete {track: {kind:"track", index, expect_name:"batuta-ears"}}`: deletes the track and its clip in ONE undo step; this call uses the internal exemption of 9.3 item 4 (also when destructive is disabled). Retry once after 500 ms on `lom_error`/`timeout` after re-reading the list.
3. Never delete, move or rename files. The recorded file stays in Live's temp folder or `Samples/Recorded`.
4. Report `cleanup: "ok"/"failed"` (`failed` is also returned as the `cleanup_failed` error code when no analysis result exists).

### 10.8 Implementation decisions (T7)

Normative; they refine 10.1–10.7.

1. Errors: `invalid_args` reason `bad_audio` (+`audio_code`); `timeout` stage `analysis` or `job` (600 s); `too_large` reason `analysis_memory` or `decoded_too_large`; `internal_error` reason `bad_worker_message`, `worker_exit` or `worker_error`.
2. Inputs: `batuta_ears {source, beats? 1..64 | bars? 1..16, spectrum?}` [D]; `record_and_analyze` takes `track_index` or `source`; `analyze_audio {path}` and `compare_audio {a, b}` (paths or `result_id`s) are read-only. `analyze_audio` and `compare_audio` read any absolute path when neither `sample_roots` nor `ears.roots` is configured (no folder restriction; every check of 10.5 other than the allowed-folder rule stays: absolute path, no odd characters, .wav/.aif/.aiff, regular file, no symlink, one hard link, owner, size and duration caps); a configured root narrows them to Live's recording folders, `Samples/Recorded` folders and those roots. The recording flow itself always keeps the folder rule. A client cancel of `batuta_ears` or `record_and_analyze` shows as `error_code: "cancelled"` in the `batuta_status` `ears.last_job`; cleanup is unchanged. One job slot is shared by all four tools (`busy`, `job_running`). No tool returns or exports the recorded file [D].
3. External-live gate: the server runs a best-effort pre-check before creating anything (armed or monitored audio tracks whose input is not a track, Resampling or No Input; a track named "Ext. In" is still unsafe). When it finds such tracks and the client can ask, it asks the owner once (section 5.6): decline ends the job `cancelled` before anything is created; accept lets the job go on and every command of it carries `external_input_ack` with the ids of the shown tracks (External devices included). Without a way to ask, the job refuses (`not_supported`/`external_input_live`) as before. The script's own refusal at the arm step (`not_supported`/`external_input_live`) stays authoritative when there is no acknowledgement; the temp track is then removed. A chosen input type named `Ext. In`, `Resampling` or `No Input` for a non-master source is refused (`not_supported`/`unsafe_source_name`); returns are tried as `A-Name` first [A: localized names].
4. Routing: `Post Mixer` is requested with the input type, falling back to `Post FX` on `not_found`; otherwise `not_supported`/`no_post_mixer`. Returns are matched by name, then as `A-Name` [A].
5. Cleanup identity (strengthens 10.7 step 1): the recorded index must match, the track must be audio with `device_count` 0, and if the create outcome was unknown the index must equal the pre-job regular track count. On any mismatch nothing is deleted, `cleanup` is `failed`, and a manual instruction is returned. After a dropped connection, cleanup waits for the reconnect before any restore step.
6. File validation (refines 10.5): the path is checked as written before any existence probe and again after `realpath`; a final-component symlink is refused; invisible, direction and control characters are refused; root comparison is NFC-normalized; `Samples/Recorded` must be the direct parent; reasons add `too_small`, `bad_format`, `too_long`, `truncated`, `file_changed`, `decoded_too_large`. Default recording folder for unsaved sets: `~/Library/Application Support/Ableton/Live Recordings` [A].
7. Analysis runs in one `node:worker_threads` Worker loaded from a fixed compiled file URL (no eval), with a 120 s timeout, heap `resourceLimits`, a 384 MiB decoded-size cap checked before decoding (whole buffers are transferred to the worker without copying), and a validated reply schema.
8. Ears tools are never destructive-classified: they never ask, `destructive:"disabled"` does not hide them, and cleanup always runs. They are not listed when `ears.enabled` is false.

## 11. Versioning and compatibility

- `protocol` is an integer, currently `1`. Any breaking change (framing, handshake, field semantics, removed/renamed command or arg, changed error code meaning) increments it. Additive changes (new commands, new optional args, new result fields) keep `1`.
- `script_version` and the npm server version are semver. The server pins `min_script_version`; below it: refuse with "Remote Script X is older than required Y: reinstall BatutaMCP from the same release".
- Server on welcome: if `protocol` differs from its own, close and report: "BatutaMCP protocol mismatch: server speaks 1, Remote Script speaks N. Install matching versions." The script rejects mismatched `hello` as in 3.4.
- Clients MUST ignore unknown result fields. The script MUST reject unknown args (strict), so a server newer than its script fails clearly at `catalog` check: the server compares `catalog` to its table and disables tools whose commands are missing, listing them in one startup message.
- `live_version` is informational; features gated by version return `not_supported` (`live_version`).

## 12. Open questions [A] (owner tests in Live)

| ID | Assumption | Fallback if false |
|---|---|---|
| A1 | A plain `create_instance` object (no `ControlSurface` base) is accepted | Runtime-import Live's `_Framework.ControlSurface` |
| A2 | `update_display` ticks ~100 ms also with Live in background | Document focus requirement; raise budget |
| A3 | Edition detectable via version string | **Verified false on Lite 12.4.7 (2026-10-28):** the version string has no edition, so the script reports `unknown`. Outcome in use: with config `edition: "auto"` and the host enabled, the server sends `edition_hint` from the running Live bundle (host probe, section 8); the script is unchanged |
| A4 | Over-limit LOM calls raise a catchable exception | Rely on prechecks only |
| A5 | `launch_quantization = 0` means none; `record_length` in beats records exactly that length | Use `record_length` rounding and trim in analysis |
| A6 | Routing display names for tracks, returns (`A-Name`), "Post Mixer"/"Post FX", "Resampling", "No Output" | Enumerate and match by `routing_get` listing; abort otherwise |
| A7 | Track-to-track input and Resampling exist in Lite | Ears refuses on Lite with `not_supported` |
| A8 | Temporary Folder default path | `ears.roots` config |
| A9 | Muted/No-Output armed track still records | Set track volume to 0 instead |
| A10 | `create_audio_track` selects the new track | Record and restore selection anyway |
| A11 | `Chain.insert_device`, `delete_device` on chains, `insert_chain` exist | `not_supported` |
| A12 | `remove_notes_by_id`, dict note specs in `add_new_notes` | Use `MidiNoteSpecification` objects / range removal |
| A13 | `Clip.quantize` takes the recording-quantization integers (`Live.Song.RecordingQuantization` `rec_q_*`; 1/4 = 1, 1/8 = 2, 1/16 = 5, 1/32 = 8 …), not `Live.Clip.GridQuantization` | Use `RecordingQuantization` when present, else the fixed integers; owner verifies 1/4 and 1/16 in Live |
| A14 | `clip.sample_rate` exists on audio clips | Read from the WAV header |
| A15 | `duplicate_clip_to_arrangement` overwrites overlapping region | Pre-clear not possible; keep the overlap precheck |
| A16 | `set_or_delete_cue` toggles at the current time; restoring the playhead is silent | Disable `cue_create`/`cue_delete` |
| A17 | `copy_pad`, `delete_all_chains` behavior | `not_supported` |
| A18 | `browser.load_item` target/replace semantics; uri stays valid within the session | Re-list before load |
| A19 | Nested/unclosed undo steps are harmless; each command yields one user-visible undo entry | Drop wrapper per command, keep `batch` |
| A20 | Recorded file stays after clip/track deletion | Analyze before cleanup (already the order) |
| A21 | `bind` path length 103 holds for the owner's home | Shorter symlink-free parent not supported; report |
| A22 | `str_for_value` on volume yields parsable dB | `volume_db` returns `null`; raw only |
| A23 | `load_item`: synchronous or asynchronous, target track (selected track), append versus instrument replacement | Synchronous path: purge right after `load_item`, also walking tracks that appeared (`song.tracks` count before/after). If nothing changed: respond `verified:false, sweep_pending:true` and run a deferred sweep from `update_display` for up to 2 s on the target track and new tracks, deleting new offending devices in its own undo step; a track found that way is reported in the sweep outcome as `new_tracks`/`landed_on`. Suite shows Max for Live devices as `is_device` in native categories, so this cleanup is their only barrier |
| A24 | `class_name` values: Max for Live devices start with `Max`; plugin devices have a distinct class (e.g. `PluginDevice`, `AuPluginDevice`) | Block by `type` and name patterns; refuse when unsure |
| A25 | Exclusive arm disarms other tracks when arming the temp track | Restore `armed_before` (already in step 10) |
| A26 | The recorded file can still grow after `is_recording` is false | Size-stability wait (already in step 9) |
| A27 | `Clip.quantize_pitch` exists | Quantize only whole clips |
| A28 | Rack variation methods (`store_variation`, `recall_selected_variation`, `delete_selected_variation`, `randomize_macros`) and a settable `selected_variation_index` exist | `not_supported` for `rack_variation` |
| A29 | `Scene.time_signature_enabled` exists for disabling a scene time signature | `scene_set` time_signature null unsupported |
| A30 | `ClipSlot.create_audio_clip(path)` exists | Use `Track.create_audio_clip` only (arrangement) |
| A31 | Track monitoring property names (`monitoring_state`, `current_monitoring_state`) | Omit `monitoring_state` from `track_set`; ears relies on mute and No Output only |
| A32 | Live writes `.asd` files next to imported samples | Document; set `sample_roots` to limit imports to folders that may receive them |
| A33 | `duplicate_clip_slot` may create a scene; `duplicate_track` of a group copies its children | Prechecks already assume the worst case |
| A34 | Superseded by A35 (input safety is by routing type object, not by name) | n/a |
| A35 | Routing type objects expose `attached_object` (a Track for track inputs) and a category/identity for Resampling and No Input | Name-collision fallback in 5.6 (collisions count as external) |
| A36 | Suite factory racks may contain Max for Live devices | With `allow_max_for_live` (default) such loads proceed; with `false` they are refused (fail closed) |
| A37 | Warping changes an imported audio clip's length in beats | Owner verifies; if lengths differ, the arrangement form requires `allow_overwrite` for all formats |
| A38 | Class names of External Audio Effect and External Instrument devices (likely `ProxyAudioEffectDevice` / `ProxyInstrumentDevice`; `ExternalAudioEffect`/`ExternalInstrument` also matched) | Match by `class_name` (fail closed on any `proxy*` class) and by device name; refuse when unsure |
| A39 | A URI prefix or source marker that distinguishes Core Library items from installed Packs and user content (exact marker unknown; Live 12.4.7: `sounds`/`drums`/`samples` items have opaque `FileId` URIs, the packs view has `query:LivePacks#www.ableton.com/0:` for Core Library, but that view is not a factory category, so no marker is applied) | Treat every preset as non-factory (needs `allow_user_presets`) |
| A41 | `Song.duplicate_track` copies the source track's arm state | Refuse duplicating the ears track and any armed audio track (5.6 rule 6) |
| A40 | Live may hand out a new Python wrapper for the same LOM object on each access, so identity is compared with `==` (as Live's own `liveobj_changed` does), with an `is` shortcut | If `==` is not stable, the ears track is forgotten and every input classifies as external (fails closed, ears unavailable) |

## Appendix A. Limits

| Limit | Value |
|---|---|
| Frame size (each direction) | 1 048 576 bytes |
| JSON depth / array / object keys / string | 32 / 10 000 / 256 / 4096 bytes |
| Name length | 128 code points |
| Hello timeout / body timeout / idle | 5 s / 5 s / 120 s |
| Ping interval | 30 s |
| Rate limit | 50 req/s, burst 100; disconnect after > 500 rejections in 10 s |
| Auth lockout | 5 failures in 60 s, 30 s |
| In-flight / queue | 16 / 64 |
| Consecutive bad frames before close | 5 |
| Drain budget per tick | 20 ms (min one command) |
| Default request timeout | 5 s (batch 10 s, browser_search 15 s, max `timeout_ms` 30 s) |
| `batch` ops | 32 |
| Notes per add/modify/remove | 2000 (`notes_get` 5000) |
| Parameters per `device_get` / `param_set` | 128 / 64 |
| Envelope steps / points | 1024 / 512 |
| Browser search nodes / results / list items | 3000 / 50 / 200 |
| List page default / max | 100 / 500 |
| `path` depth (device/browser) | 8 |
| Undo/redo steps per call | 10 |
| Confirm token TTL / pending | 60 s / 32 |
| Socket path | <= 103 bytes |
| Ears beats / file size / duration / job | 64 / 256 MiB default / 300 s / 600 s |
| Reconnect backoff / socket poll | 0.5 to 15 s / 1 s |
| Sample import size (`audio_clip_create`) | 1 GiB |
| `envelope_list` parameter scan cap | 1000 parameters |
| Browser URI map (LRU) | 5000 entries |
| Ears finalization wait | 5 s max, 200 ms poll, two equal sizes |
| Gain guard defaults | 6.0 dB jump, 0.0 dB master ceiling |
| Tools exposed | about 125 (docs/03-tool-names.md) |

## Appendix B. Server configuration keys

| Key | Default | Notes |
|---|---|---|
| `edition` | `auto` | `auto/lite/standard/suite`; env `BATUTA_EDITION` (section 8) |
| `destructive` | `confirm` | `confirm/disabled`; env `BATUTA_DESTRUCTIVE` (section 9.2) |
| `gain_guard.max_jump_db` | 6.0 | section 9.4 |
| `gain_guard.max_master_db` | 0.0 | section 9.4 |
| `browser.allow_plugins` | false | VST/AU loading via `browser_load` (7.10) |
| `browser.allow_max_for_live` | true | Max for Live (`.amxd`, M4L names, the `max_for_live` category, `Max*` devices) loads and stays; `false` restores the block, the post-load sweep and the refusal of racks holding M4L (7.10) |
| `browser.allow_external_devices` | true | External Audio Effect / External Instrument load and stay; recording with a live external input asks the owner once (5.6); `false` restores the block and the refusals |
| `browser.allow_user_presets` | true | presets from `user_library`, `packs`, `current_project` via `browser_load`; risk documented in 7.10 |
| `sample_roots` | `[]` | optional; non-empty narrows `audio_clip_create` imports to these folders, empty means any audio file (7.6) |
| `ears.enabled` | true | section 10 |
| `ears.max_bytes` / `ears.max_beats` | 256 MiB / 64 | hard max 1 GiB / 64 |
| `ears.roots` / `ears.set_roots` | `[]` / `[]` | section 10.5; `ears.set_roots` is independent of `host.set_roots` (the home folder always admits a `Samples/Recorded` folder) |
| `host.enabled` | true | host automation, docs/04-host-automation.md |
| `host.live_app` | `auto` | `auto/suite/standard/lite/intro/trial/beta`; `auto` starts the running Live, else the edition of the last connection, else Suite, Standard, Lite |
| `host.set_roots` | `[]` | optional; non-empty narrows `open_set` / `save_set_as` to these folders, empty means any folder (docs/04-host-automation.md section 5) |
| `min_script_version` | pinned in the server release | section 11 |
