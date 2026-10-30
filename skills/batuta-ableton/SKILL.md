---
name: batuta-ableton
description: "Trigger: BatutaMCP, Ableton Live, session, clip, track, scene, device, tempo, arrangement, save set, batuta_ears. General rules for driving Ableton Live 12 with BatutaMCP."
license: MIT
metadata:
  author: "paulpwo"
  version: "1.0"
---

## Activation Contract

Load before any BatutaMCP work in Ableton Live. For mixing or loudness work also load `mixing-ableton`.

## Hard Rules

- Start with `get_session_info` or `get_session_snapshot`. Read before write. Call `get_clip_notes` before editing a clip's notes.
- Never change tempo, time signature, existing clips or existing ClyphX X-Clips unless asked. Add new clips in empty slots. Change the mix only when asked. Keep the user's manual edits.
- Only irreversible actions and gain guard trips ask for confirmation. Never bypass, split, or re-route around one; explain it to the user.
- Gain guard: a raise above +6 dB per call, or a master above 0 dB, asks. Decreases never trip.
- Each change is one undo step. Do not call `undo` or `redo` unless the user asks; the model always gets a confirmation for them.
- `destructive: disabled` in the config hides delete-class tools and refuses overwrites (`not_supported`, `disabled_by_config`). Do not look for another way.
- Never create, rename or delete the track `batuta-ears`. Ears never use external inputs.

## Decision Gates

| Need | Action |
|---|---|
| Address a track, clip, scene, device, parameter | `references/addressing.md` |
| Confirmation, gain guard, undo | `references/safety.md` |
| Session/Arrangement view, clip launch quantization | `show_view`, `set_clip_trigger_quantization` |
| The user asks for transport controls or a transport panel | `show_transport_panel` (an inline panel in hosts with MCP Apps, else the transport as text) |
| Measure audio | `batuta_ears`; mixing work: `mixing-ableton` |
| Save, open, new set, export | Host tools; `references/host-and-ears.md` |
| An error code | `references/errors.md` |
| `edition_limit` | Live Lite caps tracks, scenes, returns; stop and tell the user |

## Execution Steps

1. Read the session. Note edition, tempo, tracks, empty slots.
2. Pick the narrowest tool; read the target (`get_track_info`, `get_clip_notes`, `get_device_parameters`) first.
3. Make one change. Check the result (`undoable`, errors).
4. Report what changed and how to revert (Cmd-Z in Live).

## Output Contract

Short reply: what was read, what changed (track, clip, value), anything refused and why, one next step.

## References

- `references/addressing.md`, `references/safety.md`, `references/host-and-ears.md`, `references/errors.md`
