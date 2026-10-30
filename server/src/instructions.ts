/**
 * Short usage rules sent to every MCP client in the `initialize` result (field `instructions`).
 * Plain ASCII text, no tool output, no names read from Live. The fuller guide is the
 * `batuta-ableton` skill (skills/batuta-ableton/SKILL.md).
 */
export const BATUTA_INSTRUCTIONS: string = [
  "BatutaMCP controls Ableton Live 12.",
  "- Read first: get_session_info or get_session_snapshot; get_clip_notes before editing a clip.",
  "- Do not change tempo, time signature, existing clips or X-Clips unless asked. Add clips in empty slots. Change the mix only when asked. Keep the user's manual edits.",
  "- Confirmations: model undo/redo, save_set_as onto an existing file, gain guard trips (raise above +6 dB per call, master above 0 dB) and recording while an external input is live. Never split a change or work around a refusal.",
  "- Each change is one undo step. Call undo or redo only if the user asks.",
  "- Address tracks by track_index or track {kind: track|return|master, index}; clips by clip_index; expect_name pins names.",
  "- Live Lite caps tracks and scenes (edition_limit): tell the user, do not retry.",
  "- batuta_ears uses a temporary track batuta-ears; never create or delete it. On cleanup_failed ask the user to delete it. One job at a time.",
  "- On busy or rate_limited retry once, except held_by_other_session (another Claude session holds Live): tell the user. On not_supported report details.reason.",
  "- Host tools (save_set, export_audio) need macOS Accessibility permission.",
].join("\n");
