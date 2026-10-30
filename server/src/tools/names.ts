/**
 * Public tool names (docs/03-tool-names.md). The wire command keeps its name in the Remote Script;
 * the MCP tool is called by the public name below: a compatibility name where one is already in
 * use by existing music skills, else a new normalized verb_object name. Static text only.
 */
export const PUBLIC_NAMES: Readonly<Record<string, string>> = Object.freeze({
  // song and transport
  song_info: "get_session_info", song_set: "set_song_properties", transport: "control_transport", song_set_time: "set_arrangement_time",
  stop_all_clips: "stop_all_clips", back_to_arranger: "back_to_arrangement", capture_midi: "capture_midi",
  trigger_session_record: "trigger_session_record", re_enable_automation: "re_enable_automation",
  undo_state: "get_undo_state", undo: "undo", redo: "redo",
  // tracks and mixer
  track_list: "list_tracks", track_get: "get_track_info", track_create: "create_track", track_delete: "delete_track",
  track_duplicate: "duplicate_track", track_set: "set_track_properties", track_select: "select_track", track_stop_clips: "stop_track_clips",
  meters_get: "get_meters", mixer_get: "get_mixer", mixer_set: "set_mixer", routing_get: "get_routing", routing_set: "set_routing",
  // scenes and cue points
  scene_list: "list_scenes", scene_create: "create_scene", scene_delete: "delete_scene", scene_duplicate: "duplicate_scene",
  scene_set: "set_scene_properties", scene_fire: "fire_scene", scene_capture: "capture_scene",
  cue_list: "list_cue_points", cue_create: "create_cue_point", cue_delete: "delete_cue_point", cue_set: "set_cue_point", cue_jump: "jump_to_cue_point",
  // clips and notes
  clip_list: "list_clip_slots", clip_get: "get_clip_info", slot_status: "get_slot_status", clip_create: "create_clip",
  audio_clip_create: "create_audio_clip", clip_delete: "delete_clip", clip_duplicate: "duplicate_clip", clip_set: "set_clip_properties",
  clip_crop: "crop_clip", clip_duplicate_loop: "duplicate_clip_loop", slot_fire: "fire_clip", slot_stop: "stop_clip",
  notes_get: "get_clip_notes", notes_add: "add_notes_to_clip", notes_remove: "remove_notes_from_clip", notes_modify: "modify_clip_notes",
  notes_quantize: "quantize_clip_notes",
  // envelopes and arrangement
  envelope_list: "list_clip_envelopes", envelope_get: "get_clip_envelope", envelope_set: "set_clip_envelope",
  envelope_clear: "clear_clip_envelope", envelope_clear_all: "clear_all_clip_envelopes",
  arrangement_clips: "get_arrangement_clips", arrangement_clip_create: "create_arrangement_clip",
  arrangement_duplicate: "duplicate_to_arrangement", arrangement_commit_scene: "commit_scene_to_arrangement",
  batch: "batch",
  // devices, racks, drum pads
  device_list: "list_devices", device_get: "get_device_parameters", param_get: "get_parameter", param_set: "set_device_parameter",
  device_enable: "set_device_enabled", device_delete: "delete_device", device_insert: "insert_device",
  rack_get: "get_rack", chain_set: "set_chain_properties", rack_insert_chain: "insert_rack_chain", rack_variation: "set_rack_variation",
  drum_pads_list: "list_drum_pads", drum_pad_set: "set_drum_pad", drum_pad_copy: "copy_drum_pad", drum_pad_clear: "clear_drum_pad",
  // browser
  browser_list: "list_browser_items", browser_search: "search_browser", browser_load: "load_instrument_or_effect",
  // application views
  view_show: "show_view", view_focus: "focus_view", view_get: "get_view",
});
