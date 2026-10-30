# Common error codes

Source: docs/01-protocol.md section 4.

| Code | Action |
|---|---|
| `busy` | Another client, a full queue, or an ears job running. Wait, retry once; never launch two ears jobs |
| `rate_limited` | Wait `details.retry_after_ms`, then retry once |
| `timeout` | Re-read the state before retrying; a mutation may have happened |
| `edition_limit` | Live Lite cap. Do not retry; tell the user |
| `not_supported` | Read `details.reason` (`disabled_by_config`, `gain_limit`, `external_input_live`, `record_mode_on`, `blocked_content`, `arrangement`, `edition`, `live_version`) and report it. Do not work around it |
| `not_found` | Re-list; `name_mismatch` means indices moved |
| `invalid_args` | Fix the argument; `ambiguous_name` needs an index; `overlap` needs the user's approval for `allow_overwrite` |
| `out_of_range` | Use `details.min` / `max` |
| `lom_error` | Live raised; `details.partial` true means something already changed: re-read |
| `cleanup_failed` | Ask the user to delete the `batuta-ears` track |
| `permission_required` | macOS Accessibility or Automation permission for host tools |
| `version_mismatch` | Remote Script and server versions differ: reinstall both from the same release |
