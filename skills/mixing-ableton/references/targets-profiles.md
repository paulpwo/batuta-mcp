# Targets and profiles

Never quote a number without its status. Ask the user which target applies (release platform) before any loudness or true-peak fix.

| Target | Value | Status |
|---|---|---|
| Streaming | -14 LUFS integrated; true peak at or below -1 dBTP, at or below -2 dBTP if louder than -14 | verified (Spotify) |
| Apple Music, YouTube | about -16 and about -14 LUFS, -1 dBTP | secondary (third-party reports) |
| Club | nominal -9 LUFS, range -11 to -8, ceiling -1 dBTP | convention |

## Rules

- A report measures a section (`beats`), not the whole song. For a delivery check, record the full song (up to 64 beats per run; split a longer song into sections and report each). Say which section the number covers.
- Genre names (house, afro house, techno, salsa, bachata, merengue, cumbia, gaita, ballad) only suggest a default target: club for house, afro house and techno, streaming for the rest. They carry no band curves; say "calibrate from references".
- Reference = a finished song of the user's. Either analyze its file with `analyze_audio {path}` (the path must sit in a sample folder, Live's recording folders or a `Samples/Recorded` folder) or measure it playing in Live with `batuta_ears`; keep the `result_id`.
- `compare_audio {a, b}`: each side is an absolute file path or a `result_id` (this session only, the last 8 are kept; an unknown id returns `not_found` with `unknown_result`; a relative path returns `bad_reference`). Result: `a` and `b` (each with `from` and the report fields without spectrum), `deltas`, `note`. `deltas` has `integrated_lufs`, `short_term_max_lufs`, `momentary_max_lufs`, `lra_lu`, `true_peak_dbtp`, `sample_peak_dbfs`, `rms_dbfs`, `crest_db`, `correlation` and `spectrum` (array of `{center_hz, delta_db}`). All deltas are b minus a (LU or dB, one decimal; correlation three decimals); `null` when a side has no value.
- There is no target-gap field: compute it yourself as `integrated_lufs` minus the target. Use `compare_audio` a = before, b = after to show what a change did, or a = reference, b = current mix to see the distance from the reference. Spectrum deltas are absolute levels, so match loudness first (or judge the shape, not the offset).
- `batuta_ears` and `record_and_analyze` record in real time; `analyze_audio` and `compare_audio` never record and never write. They share one job slot with ears (`busy`, `job_running`).
- Max short-term loudness is `short_term_max_lufs`; it is not a target by itself.
- Report a loudness gap in LU, positive when louder than the target.
