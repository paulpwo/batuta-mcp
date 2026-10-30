# Confirmations, gain guard, undo, editions

Source: docs/01-protocol.md sections 8 and 9.

## Confirmations (default `confirm: "irreversible"`)

Asked only for:
- Actions Live's undo cannot reverse: `save_set_as` onto an existing file, and `undo` / `redo` called by the model (the undo stack also holds the user's manual edits).
- Gain guard trips.

Everything else (deletes, `remove_notes_from_clip`, crops, envelope clears, overwrites) runs without a prompt and is one undo step; the result says `undoable: true`. With `confirm: "destructive"` every destructive tool asks.

How a confirmation arrives: either the client shows a form (elicitation), or the tool returns `confirmation_required` with a `confirm_id` and `summary`; the user approves, then call `batuta_confirm {confirm_id, summary}` with the exact summary. Never call `batuta_confirm` without the user having approved. A cancelled confirmation returns `{"cancelled": true}`: stop.

## Gain guard

Covers `set_track_volume` / `set_mixer` volume (tracks, returns, master; not sends), rack chain volume, and dB gain/volume/level/output parameters (including default `Macro n`). Trips when the raise exceeds `gain_guard.max_jump_db` (default 6 dB), the master target exceeds `max_master_db` (default 0 dB), or the dB value cannot be parsed. Decreases never trip. With `destructive: "disabled"` a trip is refused with `not_supported` (`gain_limit`). Never split a jump into smaller calls to avoid it.

## `destructive: "disabled"`

Tools classified `always` are not listed; overwrite, `replace`, multi-step undo and gain trips are refused (`disabled_by_config`). It is the user's hard stop; do not try to work around it.

## Undo

Every script mutation is exactly one Live undo step. `get_undo_state` reads the stack. Ears add about 6 to 8 steps: tell the user not to press Undo blindly afterwards.

## Editions

Live Lite: 8 tracks, 16 scenes, 2 returns, and fewer devices. Suite/Standard: no track or scene cap, 12 returns. `edition_limit` carries `details.resource`, `limit`, `current`: report it and ask the user. Max for Live is never available.
