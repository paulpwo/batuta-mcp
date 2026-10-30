# Diagnosis rules

Fields come from the `batuta_ears` report (protocol section 10.6). Every threshold is convention (tune by ear) unless marked verified. A `null` field comes with a `warnings` entry: skip its rule and say so.

## Field notes

- `batuta_ears {source, beats? | bars?, spectrum?}`: `beats` 1..64 (default 16) or `bars` 1..16, never both. `record_and_analyze` is the same tool; give `track_index` (regular track) or `source`, not both. `spectrum:false` drops the bands.
- Result: `result_id` (use it in `compare_audio`), `source` (`kind`, `index`, `name`), `beats`, `report`, `file` (`path`, `size`), `warnings`, `cleanup` (`ok` or `failed`), `manual` (only when cleanup failed), `elapsed_ms`, `note`.
- `report`: `duration_s`, `sample_rate`, `channels`, `bit_depth`, `mono`, `integrated_lufs`, `short_term_max_lufs`, `momentary_max_lufs`, `lra_lu`, `true_peak_dbtp`, `true_peak_dbtp_per_channel` (array), `sample_peak_dbfs`, `rms_dbfs`, `crest_db`, `spectrum`, `correlation`, `warnings`. Undefined values are `null`.
- `spectrum` is an array of 10 objects `{center_hz, level_db}` at 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 Hz. `level_db` is relative to a full-scale sine (0 dB) and is `null` above Nyquist.
- Two warning lists: `report.warnings` (analysis, lowercase codes such as silence or clipping) and top-level `warnings` (job: `source_muted`, `solo_active`, `slot_stop_failed`, `rearm_failed:<n>`, `ears_track_missing`, `cleanup_identity_mismatch`). Read both. `source_muted` and `solo_active` mean the tap may be silent or wrong: tell the user before diagnosing.
- Integrated loudness needs 400 ms or more; short-term max needs 3 s; LRA needs 3 s of gated content. Use 16 beats or more for loudness, 32 or more for a stable LRA.
- One run measures ONE source over ONE section. Compare sections only when the same beats were recorded. The tap is post-fader (Post Mixer, falling back to Post FX), so mute, solo and volume matter.
- Mono source (`mono: true`): no +3 dB compensation and `correlation` is null.
- `analyze_audio {path}` returns `result_id`, `report`, `file` (`format`, `size`) for an existing WAV or AIFF; no recording.
- One job at a time for all four ears tools: a second call gets `busy` with `details.reason` `job_running`; wait and retry.
- Ears never ask for confirmation. A `cleanup_failed` error carries `details.manual`: relay it, the track named `batuta-ears` must be deleted by hand.
- Errors worth relaying: `not_supported` with `external_input_live`, `record_mode_on` or `no_post_mixer`; `edition_limit` (Lite, no free track slot); `invalid_args` with `bad_audio` or a file-path reason; `timeout`.

## Checks

| Check | Fields | Flag when | Status |
|---|---|---|---|
| Clipping | `sample_peak_dbfs`, `warnings` | at or above 0 dBFS, or a clipping warning | convention |
| True peak | `true_peak_dbtp` | above -1 dBTP; above -2 dBTP if `integrated_lufs` is above -14 (depends on target: ask first) | verified for streaming (Spotify) |
| Loudness gap | `integrated_lufs` vs target | beyond +/- 1 LU of the target | -14 LUFS verified; others convention |
| Peak-to-loudness | `true_peak_dbtp` minus `integrated_lufs` | below 8 dB on a full mix suggests heavy limiting | convention |
| Over-compressed | `crest_db` | below 6 dB on vocals, bass, percussion tracks; master below 8 dB | convention |
| Under-compressed | `crest_db` | above 18 dB on vocals or bass | convention |
| Dynamic range | `lra_lu` | informational; compare only against the user's own reference | convention |
| Mono / phase | `correlation` | master below 0.3; any track below 0 | convention |
| Low-end excess | `spectrum` 63 and 125 Hz | a non-bass track (not kick, bass, sub, drum bus) whose 63/125 Hz bands sit within 6 dB of its loudest band | convention |
| Masking | two runs, `spectrum` | kick and bass both peak in the same octave band (63 or 125 Hz) and their levels are within 3 dB | convention |
| Harshness / dullness | `spectrum` 2k-8k vs 250-500 | judge only against the user's reference run, never a genre curve | convention |
| Silence / short | `warnings` | silent or too short: repeat on a louder section | contract |

## Order of work

Safety (clipping, true peak), loudness gap, spectrum balance and masking, dynamics, phase, tone.

## Notes

- Masking has no direct field: measure each track separately with `source` = that track (one run each, same beats) and compare the spectra.
- Exclude muted tracks and tracks outside the soloed set when comparing.
- Never call a band wrong for a genre. Compare only against the user's reference (`compare_audio` between a reference file and the current mix).
