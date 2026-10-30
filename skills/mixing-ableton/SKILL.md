---
name: mixing-ableton
description: "Trigger: mix, mixing, master, loudness, LUFS, true peak, headroom, EQ, compressor, limiter, batuta_ears. Measure and fix a mix in Ableton Live with BatutaMCP."
license: MIT
metadata:
  author: "paulpwo"
  version: "1.0"
---

## Activation Contract

Load `batuta-ableton` first for the general BatutaMCP rules (addressing, confirmations, undo, host tools).

Load when the user asks to measure, diagnose, balance, loudness-match or master a mix in Ableton Live through BatutaMCP (`batuta_ears` and the mixer/device tools).

## Hard Rules

- Change the mix only when the user asks. Measuring alone is allowed. Never change tempo, meter or existing clips.
- Loop: measure (ears) -> ONE change -> re-measure the same section -> `compare_audio`. Report before and after numbers. The user's ear wins.
- Native Live devices only: EQ Eight, Compressor, Glue Compressor, Limiter, Utility, Gate. Never Max for Live. Never third-party plugins unless the user asks.
- Gain guard: at most +6 dB per call, master at or below 0 dB. Decreases never trip. If a call trips it or asks for confirmation, explain why to the user; never split the jump to evade it.
- One ears job at a time (`busy`, `job_running`): wait, never launch two. Ears never ask for confirmation.
- Ears are refused while an external input is live (microphone or line-in monitored or armed, or an External Audio Effect or External Instrument device). Tell the user why; do not arm or reroute to work around it.
- Ears create and remove their own `batuta-ears` track. Never create, rename or delete that name by hand. On `cleanup_failed`, tell the user to delete that track manually.
- Live Lite allows 8 tracks: ears need one free slot. Lite lacks some devices (`references/recipes.md`).
- Ears record in real time and add about 6 to 8 undo steps: do not call `undo` to revert them; warn the user not to press Undo blindly.
- Ask the delivery target (platform or club) BEFORE any loudness or true-peak fix. Mark every number without a verified source as convention.
- Read parameter min/max with `get_device_parameters` before `set_device_parameter`; values are raw Live units.

## Decision Gates

| Situation | Action |
|---|---|
| Transport recording or record mode on | Ask the user to stop recording; ears refuse |
| Source muted or other track soloed | Warn: the tap may be silent or wrong |
| Report has `warnings` or null fields | Do not diagnose that field; say why |
| Re-measure does not move | Check device order and ceiling first; never push harder |
| Need thresholds / fixes / targets | `references/diagnosis.md` / `recipes.md` / `targets-profiles.md` |

## Execution Steps

1. `get_session_snapshot` (tempo, tracks, mute/solo, devices). Never edit what it shows without being asked.
2. Ask the user to play or loop one section. `batuta_ears` with `source` (master or one track) and `beats` (1-64) or `bars` (1-16). Keep the `result_id`.
3. Diagnose with `references/diagnosis.md`, safety first: clipping, true peak, loudness gap, then spectrum, dynamics, phase.
4. Propose the single most valuable change; wait for approval.
5. Apply it (`load_instrument_or_effect`, `set_device_parameter`, `set_track_volume`).
6. `batuta_ears` again with the same source and length; `compare_audio {a: before result_id, b: after result_id}`; report before and after.

## Output Contract

Short reply: diagnosis with numbers, the one change proposed or made, before and after values, what is convention, one next question. Say which source and section were measured.

## References

- `references/diagnosis.md`, `references/recipes.md`, `references/targets-profiles.md`
- `assets/example-session.md`
