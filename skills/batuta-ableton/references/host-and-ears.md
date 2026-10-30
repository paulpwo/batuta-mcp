# Host automation and ears

Source: docs/04-host-automation.md, docs/01-protocol.md section 10.

## Host tools (macOS only, listed when `host.enabled`)

| Tool | Notes |
|---|---|
| `launch_live {app?}` | Starts or activates Live |
| `open_set {path}` / `new_set` | Live's own save-changes dialog protects unsaved edits |
| `save_set` | A never-saved set opens Live's Save dialog (`result: save_dialog_open`): tell the user or use `save_set_as` |
| `save_set_as {path}` | Asks for confirmation only when the file exists |
| `export_audio` | Opens Live's export dialog; the user finishes it |

Paths: absolute, `.als`, inside the configured set folders (defaults `~/Music/Ableton` and `~/Documents/PRODUCTION`). They need macOS Accessibility (and Automation) permission for the app running the MCP client: on `permission_required`, give the user the instruction from `details.instructions`. They work without a Remote Script connection.

## Ears

- `batuta_ears {source, beats|bars, spectrum?}` records a track, return or master inside Live onto a temporary audio track named `batuta-ears`, analyzes the file, and removes the track. `record_and_analyze` is the same with `track_index`.
- `analyze_audio {path}` reads an existing WAV/AIFF inside allowed folders. `compare_audio {a, b}` takes paths or `result_id`s and returns b minus a.
- Never records microphone or line-in; refused while an external input is live (`not_supported`, `external_input_live`).
- One job at a time (`busy`, `job_running`). Never asks for confirmation. Needs one free track slot on Lite.
- `cleanup_failed`: tell the user to delete the track named `batuta-ears` manually (`details.manual`).
- Mixing decisions: use `mixing-ableton`.
