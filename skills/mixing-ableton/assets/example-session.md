# Example session (illustrative numbers)

User: "The master feels quiet for streaming, can you check it?"

1. `get_session_snapshot`: 6 tracks, master has a Limiter, nothing muted. Free track slot exists.
2. Ask: "Which platform is the release for?" -> "Spotify."
3. User loops the chorus. `batuta_ears {source: {kind: "master"}, beats: 16}` (result_id `ears-1a2b3c4d`):
   `integrated_lufs -17.4`, `true_peak_dbtp -3.1`, `crest_db 13.2`, no warnings.
4. Diagnosis: 3.4 LU below -14 LUFS, true peak has 1.1 dB of room under -2 dBTP. Propose: Limiter gain +2 dB, ceiling -2 dBTP. User approves.
5. `set_device_parameter` on the Limiter (min/max read first). Re-measure with the same source and beats:
   `integrated_lufs -15.3`, `true_peak_dbtp -2.0`, `crest_db 11.0`.
6. `compare_audio {a: "ears-1a2b3c4d", b: <second result_id>}`, `deltas.integrated_lufs`: +2.1 LU. Report: still 1.3 LU under target; next step would be another +1 dB, crest would drop to about 10. Ask: "One more step, or does it sound right?"
