"""Clip, slot and note commands (docs/01-protocol.md section 7.6).

Each mutating command has a `check` function that resolves references and runs every guard
without touching the Live Object Model. It is installed as the precheck (so a refusal never opens an
undo step) and called again at the start of the handler (so the same guards hold per op inside
`batch`). `ctx.note_mutation()` comes right before the first write. Notes use the Live 11+ extended
note API only; note objects returned by Live are snapshots that reach the clip through
`apply_note_modifications`.
"""

import json

from . import clip_lom
from . import lom
from . import validator as v
from .errors import BatutaError
from .registry import Command

_CLIP_SET_FIELDS = ("name", "color", "muted", "looping", "loop_start", "loop_end", "start_marker",
                    "end_marker", "gain", "pitch_coarse", "pitch_fine", "warping")
_AUDIO_ONLY_FIELDS = ("gain", "pitch_coarse", "pitch_fine", "warping")
_RANGE_FIELDS = ("from_pitch", "pitch_span", "from_time", "time_span")
GRIDS = ("1/4", "1/8", "1/16", "1/32")
NOTES_PAGE_BYTES = 900_000  # a notes_get page stops before this many encoded bytes (spec 7.6)


def _not_supported(reason, message, **details):
    details["reason"] = reason
    return BatutaError("not_supported", message, details)


# ----------------------------------------------------------------- reads

def _clip_list(ctx, args):
    track = lom.resolve_track(ctx.song, args["track"])
    shown = lom.normal_ref(args["track"])
    entries = list(enumerate(clip_lom.session_slots(track)))
    if not args["include_empty"]:
        entries = [entry for entry in entries if clip_lom.has_clip(entry[1])]
    return lom.page(entries, args, lambda _, entry: lom.slot_info(shown, entry[0], entry[1]))


def _clip_get(ctx, args):
    return {"clip": clip_lom.clip_info(clip_lom.resolve_clip(ctx.song, args["clip"]))}


def _slot_status(ctx, args):
    _, slot = clip_lom.resolve_slot(ctx.song, args["track"], args["slot"])
    return lom.slot_info(lom.normal_ref(args["track"]), args["slot"], slot)


# ----------------------------------------------------------------- clip_create / audio_clip_create

def _create_check(ctx, args):
    track, slot = clip_lom.resolve_slot(ctx.song, args["track"], args["slot"])
    if not clip_lom.is_midi_track(track):
        raise lom.invalid("not_midi_track", "clip_create needs a MIDI track")
    if clip_lom.has_clip(slot):
        raise lom.invalid("slot_occupied", "the slot already holds a clip")
    return track, slot


def _clip_create(ctx, args):
    track, slot = _create_check(ctx, args)
    ctx.note_mutation()
    slot.create_clip(args["length"])
    if "name" in args:
        slot.clip.name = args["name"]
    if "color" in args:
        slot.clip.color = args["color"]
    target = clip_lom.session_target(track, lom.normal_ref(args["track"]), args["slot"], slot)
    return {"clip": clip_lom.clip_info(target)}


def _audio_prepare(args, registry):
    """Static form and path rules (socket thread); the LOM-dependent ones are in `_audio_check`."""
    session = "slot" in args
    arrangement = "position" in args
    if session == arrangement:
        raise lom.invalid("form", "give either slot (session) or position (arrangement)")
    name = clip_lom.check_audio_path(args["file_path"])
    if session:
        if "expected_length_beats" in args or "allow_overwrite" in args:
            raise lom.invalid("form", "expected_length_beats and allow_overwrite belong to the arrangement form")
    elif name.endswith(clip_lom.HEADER_EXTENSIONS):
        if "expected_length_beats" not in args:
            raise lom.invalid("form", "the arrangement form needs expected_length_beats")
    elif args.get("allow_overwrite") is not True:
        # Length cannot be derived for .flac/.mp3 and warping can change it (A37): overlap is unknowable.
        raise lom.invalid("length_unknown", "this format needs allow_overwrite:true in the arrangement form")
    return args


def _audio_check(ctx, args):
    if ctx.flags.get("allow_audio_import") is not True:
        raise _not_supported("disabled_by_config", "audio_clip_create is disabled: the server did not enable audio import for this connection")
    _audio_prepare(args, ctx.registry)  # a batch op or direct handler call gets the same rules
    song = ctx.song
    track = lom.resolve_track(song, args["track"])
    if not clip_lom.is_audio_track(track):
        raise lom.invalid("not_audio_track", "audio_clip_create needs an audio track")
    if "slot" in args:
        _, slot = clip_lom.resolve_slot(song, args["track"], args["slot"])
        if clip_lom.has_clip(slot):
            raise lom.invalid("slot_occupied", "the slot already holds a clip")
        return track, slot
    expected = args.get("expected_length_beats")
    if expected is not None and args.get("allow_overwrite") is not True:
        found = clip_lom.overlapping(clip_lom.arrangement_clips(track), args["position"],
                                     args["position"] + expected)
        if found:
            raise clip_lom.overlap_error(found)
    return track, None


def _audio_clip_create(ctx, args):
    track, slot = _audio_check(ctx, args)
    shown = lom.normal_ref(args["track"])
    if slot is not None:
        ctx.note_mutation()
        slot.create_audio_clip(args["file_path"])
        return {"clip": clip_lom.clip_info(clip_lom.session_target(track, shown, args["slot"], slot))}
    before = clip_lom.arrangement_clips(track)
    ctx.note_mutation()
    track.create_audio_clip(args["file_path"], args["position"])
    created = clip_lom.find_created(track, before, args["position"])
    target = clip_lom.arrangement_target(track, shown, created) if created is not None else None
    if target is None:
        raise BatutaError("lom_error", "create_audio_clip created no clip",
                          {"exception": "NoNewClip", "partial": True})
    return {"clip": clip_lom.clip_info(target)}


# ----------------------------------------------------------------- clip_delete

def _delete_check(ctx, args):
    return clip_lom.resolve_clip(ctx.song, args["clip"], args.get("expect_name"))


def _clip_delete(ctx, args):
    target = _delete_check(ctx, args)
    deleted = {"name": lom.text(lom.safe(lambda: target.clip.name))}
    ctx.note_mutation()
    if target.kind == "session":
        target.slot.delete_clip()
    else:
        target.track.delete_clip(target.clip)
    return {"deleted": deleted}


# ----------------------------------------------------------------- clip_duplicate

def _duplicate_check(ctx, args):
    song = ctx.song
    source = args["from"]
    src_track, src_slot = clip_lom.resolve_slot(song, source["track"], source["slot"])
    if not clip_lom.has_clip(src_slot):
        raise lom.not_found("clip", source["slot"], "empty_slot")
    if "to" not in args:
        if args["allow_overwrite"]:
            raise lom.invalid("overwrite_needs_target", "allow_overwrite only applies together with to")
        ctx.edition.check("scenes", len(song.scenes))  # duplicate_clip_slot may append a scene (A33)
        return src_track, src_slot, None, None
    destination = args["to"]
    dst_track, dst_slot = clip_lom.resolve_slot(song, destination["track"], destination["slot"])
    if lom.same(src_track, dst_track) and source["slot"] == destination["slot"]:
        raise lom.invalid("same_slot", "source and target are the same slot")
    if clip_lom.is_midi_clip(src_slot.clip) != clip_lom.is_midi_track(dst_track):
        raise lom.invalid("incompatible_track", "the target track cannot hold this kind of clip")
    if clip_lom.has_clip(dst_slot) and not args["allow_overwrite"]:
        raise lom.invalid("slot_occupied", "the target slot holds a clip; pass allow_overwrite to replace it")
    return src_track, src_slot, dst_track, dst_slot


def _clip_duplicate(ctx, args):
    src_track, src_slot, dst_track, dst_slot = _duplicate_check(ctx, args)
    if dst_slot is not None:
        destination = args["to"]
        ctx.note_mutation()
        src_slot.duplicate_clip_to(dst_slot)
        target = clip_lom.session_target(dst_track, lom.normal_ref(destination["track"]),
                                         destination["slot"], dst_slot)
        return {"clip": clip_lom.clip_info(target)}
    index = args["from"]["slot"]
    before = [clip_lom.has_clip(slot) for slot in clip_lom.session_slots(src_track)]
    ctx.note_mutation()
    returned = src_track.duplicate_clip_slot(index)
    slots = clip_lom.session_slots(src_track)
    if len(slots) > len(before):  # Live inserted a new scene right below the source
        position = index + 1
    elif type(returned) is int and 0 <= returned < len(slots):
        position = returned
    else:  # no new scene and no usable return value: the one slot that became occupied
        position = next((i for i, slot in enumerate(slots) if clip_lom.has_clip(slot) and not before[i]), None)
    if position is None or position >= len(slots) or not clip_lom.has_clip(slots[position]):
        raise BatutaError("lom_error", "duplicate_clip_slot created no clip",
                          {"exception": "NoNewClip", "partial": True})
    target = clip_lom.session_target(src_track, lom.normal_ref(args["from"]["track"]), position, slots[position])
    return {"clip": clip_lom.clip_info(target)}


def _duplicate_delta(args):
    return None if "to" in args else {"scenes": 1}


# ----------------------------------------------------------------- clip_set

def _pair(clip, args, first, second, read_first, read_second, reason):
    """(current, new) for a start/end pair when either is being set, else None. Validates start < end."""
    if first not in args and second not in args:
        return None
    current = (float(read_first(clip)), float(read_second(clip)))
    new = (args.get(first, current[0]), args.get(second, current[1]))
    if not new[0] < new[1]:
        raise lom.invalid(reason, "%s must be smaller than %s" % (first, second),
                          **{first: new[0], second: new[1]})
    return current, new


def _read_loop_start(clip):
    return clip.loop_start


def _read_loop_end(clip):
    return clip.loop_end


def _read_start_marker(clip):
    return clip.start_marker


def _read_end_marker(clip):
    return clip.end_marker


def _write_loop_start(clip, value):
    clip.loop_start = value


def _write_loop_end(clip, value):
    clip.loop_end = value


def _write_start_marker(clip, value):
    clip.start_marker = value


def _write_end_marker(clip, value):
    clip.end_marker = value


def _write_pair(clip, args, pair, names, writers):
    """Write a start/end pair in the order that never passes through an empty or inverted range."""
    current, new = pair
    first_name, second_name = names
    write_first, write_second = writers
    if current[0] < new[1]:  # moving the end first keeps start < end
        steps = [(second_name, write_second, new[1]), (first_name, write_first, new[0])]
    else:
        steps = [(first_name, write_first, new[0]), (second_name, write_second, new[1])]
    for name, write, value in steps:
        if name in args:
            write(clip, value)


def _growth_check(target, growth):
    """Refuse a change that could stretch an arrangement clip over the next clip (assumption A15 area:
    the exact extent rules of Live are unverified, so growth into a neighbour fails closed)."""
    if growth <= clip_lom.OVERLAP_EPSILON:
        return
    _, end = clip_lom.clip_span(target.clip)
    found = clip_lom.overlapping(clip_lom.arrangement_clips(target.track), end, end + growth)
    if found:
        raise clip_lom.overlap_error(found, growth=growth)


def _set_growth(clip, args):
    """Beats the clip's played region would gain: the loop span when looping, else the marker span."""
    if not any(field in args for field in ("looping", "loop_start", "loop_end", "start_marker", "end_marker")):
        return 0.0
    if args.get("looping", bool(clip.looping)):
        new = args.get("loop_end", clip.loop_end) - args.get("loop_start", clip.loop_start)
    else:
        new = args.get("end_marker", clip.end_marker) - args.get("start_marker", clip.start_marker)
    return float(new) - float(clip.length)


def _set_check(ctx, args):
    target = clip_lom.resolve_clip(ctx.song, args["clip"])
    if not any(field in args for field in _CLIP_SET_FIELDS):
        raise lom.invalid("at_least_one", "give at least one field to change")
    clip = target.clip
    wanted = [field for field in _AUDIO_ONLY_FIELDS if field in args]
    if wanted and not clip_lom.is_audio_clip(clip):
        raise lom.invalid("audio_only", "these fields only exist on audio clips", fields=wanted)
    loop = _pair(clip, args, "loop_start", "loop_end", _read_loop_start, _read_loop_end, "loop_range")
    markers = _pair(clip, args, "start_marker", "end_marker", _read_start_marker, _read_end_marker, "marker_range")
    _growth_check(target, _set_growth(clip, args) if target.kind == "arrangement" else 0.0)
    return target, loop, markers


def _clip_set(ctx, args):
    target, loop, markers = _set_check(ctx, args)
    clip = target.clip
    ctx.note_mutation()
    if "name" in args:
        clip.name = args["name"]
    if "color" in args:
        clip.color = args["color"]
    if "muted" in args:
        clip.muted = args["muted"]
    if "looping" in args:
        clip.looping = args["looping"]
    if markers is not None:
        _write_pair(clip, args, markers, ("start_marker", "end_marker"),
                    (_write_start_marker, _write_end_marker))
    if loop is not None:
        _write_pair(clip, args, loop, ("loop_start", "loop_end"), (_write_loop_start, _write_loop_end))
    if "gain" in args:
        clip.gain = args["gain"]
    if "pitch_coarse" in args:
        clip.pitch_coarse = args["pitch_coarse"]
    if "pitch_fine" in args:
        clip.pitch_fine = args["pitch_fine"]
    if "warping" in args:
        clip.warping = args["warping"]
    return {"clip": clip_lom.clip_info(target)}


# ----------------------------------------------------------------- crop and duplicate_loop

def _resolve_only(ctx, args):
    return clip_lom.resolve_clip(ctx.song, args["clip"])


def _crop_check(ctx, args):
    target = _resolve_only(ctx, args)
    if target.kind == "arrangement":  # crop trims to the loop region, which may be wider than the played one
        clip = target.clip
        _growth_check(target, float(clip.loop_end) - float(clip.loop_start) - float(clip.length))
    return target


def _clip_crop(ctx, args):
    target = _crop_check(ctx, args)
    ctx.note_mutation()
    target.clip.crop()
    return {"clip": clip_lom.clip_info(target)}


def _loop_check(ctx, args):
    target = _resolve_only(ctx, args)
    if target.kind == "arrangement":  # the doubled loop could run over the next arrangement clip
        raise _not_supported("arrangement", "duplicate_loop is not offered for arrangement clips")
    return target


def _clip_duplicate_loop(ctx, args):
    target = _loop_check(ctx, args)
    ctx.note_mutation()
    target.clip.duplicate_loop()
    return {"clip": clip_lom.clip_info(target)}


# ----------------------------------------------------------------- slot_fire / slot_stop

def _group_would_record(song, group, index):
    """True when launching row `index` of a group would start recording on an armed empty child slot
    ("Start Recording on Scene Launch"). Fails closed: an unreadable child counts as recording."""
    try:
        for child in lom.descendants(song, group):
            slots = list(child.clip_slots)
            if lom.is_armed(child) and index < len(slots) and not slots[index].has_clip:
                return True
    except (AttributeError, RuntimeError):
        return True
    return False


def _slot_fire_check(ctx, args):
    song = ctx.song
    track, slot = clip_lom.resolve_slot(song, args["track"], args["slot"])
    ctx.recording.check_playback_while_recording(song)  # rule 4 tail: record flags already on
    if "record_length" in args:
        ctx.recording.check_record_start("slot_fire")  # rule 4: an explicit recording
    elif not clip_lom.has_clip(slot) and lom.is_armed(track):
        ctx.recording.check_record_start("slot_fire")  # rule 4: firing an empty slot on an armed track
    elif lom.safe(lambda: track.is_foldable) is not False and _group_would_record(song, track, args["slot"]):
        ctx.recording.check_record_start("slot_fire")  # rule 4: a group slot launches armed empty children
    return slot


def _slot_fire(ctx, args):
    slot = _slot_fire_check(ctx, args)
    ctx.note_mutation()
    if "record_length" in args and "launch_quantization" in args:
        slot.fire(record_length=args["record_length"], launch_quantization=args["launch_quantization"])
    elif "record_length" in args:
        slot.fire(record_length=args["record_length"])
    elif "launch_quantization" in args:
        slot.fire(launch_quantization=args["launch_quantization"])
    else:
        slot.fire()
    return {}


def _slot_stop_check(ctx, args):
    return clip_lom.resolve_slot(ctx.song, args["track"], args["slot"])[1]


def _slot_stop(ctx, args):
    slot = _slot_stop_check(ctx, args)
    ctx.note_mutation()
    slot.stop()
    return {}


# ----------------------------------------------------------------- notes

def _byte_budget_page(notes, args):
    """A notes page of at most `limit` notes that stops before NOTES_PAGE_BYTES of encoded JSON
    (always at least one note) and sets next_offset when notes remain."""
    total = len(notes)
    position = args["offset"]
    rows, used = [], 0
    while position < total and len(rows) < args["limit"]:
        row = clip_lom.note_json(notes[position])
        size = len(json.dumps(row)) + 2
        if rows and used + size > NOTES_PAGE_BYTES:
            break
        rows.append(row)
        used += size
        position += 1
    return {"items": rows, "total": total, "next_offset": position if position < total else None}


def _notes_get(ctx, args):
    target = clip_lom.midi_target(ctx.song, args["clip"])
    clip = target.clip
    notes = clip.get_notes_extended(args["from_pitch"], args["pitch_span"], args["from_time"], args["time_span"])
    notes = sorted(notes, key=lambda note: (float(note.start_time), int(note.pitch), int(note.note_id)))
    return _byte_budget_page(notes, args)


def _notes_add_check(ctx, args):
    return clip_lom.midi_target(ctx.song, args["clip"])


def _notes_add(ctx, args):
    target = _notes_add_check(ctx, args)
    specs = clip_lom.note_specs(args["notes"])
    ctx.note_mutation()
    target.clip.add_new_notes(specs)
    return {"added": len(specs)}


def _remove_prepare(args, registry):
    if "note_ids" in args and len(set(args["note_ids"])) != len(args["note_ids"]):
        raise lom.invalid("duplicate_note_id", "note_ids holds a duplicate")
    return args


def _remove_check(ctx, args):
    target = clip_lom.midi_target(ctx.song, args["clip"])
    if "note_ids" in args:
        if not hasattr(target.clip, "remove_notes_by_id"):  # assumption A12
            raise _not_supported("live_version", "this Live version cannot remove notes by id")
        present = {int(note.note_id) for note in clip_lom.all_notes(target.clip)}
        if not any(note_id in present for note_id in args["note_ids"]):
            raise lom.not_found("note", args["note_ids"][0], missing=len(args["note_ids"]))
    return target


def _range_of(args):
    """The note range to remove; omitted parts widen to everything (spec: omitted means clear all)."""
    return (args.get("from_pitch", 0), args.get("pitch_span", 128), args.get("from_time", clip_lom.NOTE_TIME_MIN),
            args.get("time_span", clip_lom.NOTE_TIME_SPAN))


def _notes_remove(ctx, args):
    target = _remove_check(ctx, args)
    clip = target.clip
    if "note_ids" in args:
        present = {int(note.note_id) for note in clip_lom.all_notes(clip)}
        wanted = [note_id for note_id in args["note_ids"] if note_id in present]
        ctx.note_mutation()
        clip.remove_notes_by_id(wanted)
        return {"removed": len(wanted), "missing": len(args["note_ids"]) - len(wanted)}
    window = _range_of(args)
    before = len(clip.get_notes_extended(*window))
    ctx.note_mutation()
    clip.remove_notes_extended(*window)
    return {"removed": before - len(clip.get_notes_extended(*window))}


def _modify_prepare(args, registry):
    seen = set()
    for index, change in enumerate(args["notes"]):
        if len(change) == 1:
            raise lom.invalid("empty_modification", "notes[%d] changes nothing" % index)
        if change["note_id"] in seen:
            raise lom.invalid("duplicate_note_id", "notes[%d] repeats a note_id" % index)
        seen.add(change["note_id"])
    return args


def _modify_check(ctx, args):
    target = clip_lom.midi_target(ctx.song, args["clip"])
    known = {int(note.note_id): note for note in clip_lom.all_notes(target.clip)}
    for change in args["notes"]:
        if change["note_id"] not in known:
            raise lom.not_found("note", change["note_id"])
    return target, known


def _apply_note_fields(note, change):
    """Explicit literal setters: only the fields the client named reach the note object."""
    if "pitch" in change:
        note.pitch = int(change["pitch"])
    if "start_time" in change:
        note.start_time = float(change["start_time"])
    if "duration" in change:
        note.duration = float(change["duration"])
    if "velocity" in change:
        note.velocity = float(change["velocity"])
    if "mute" in change:
        note.mute = bool(change["mute"])
    if "probability" in change:
        note.probability = float(change["probability"])
    if "velocity_deviation" in change:
        note.velocity_deviation = float(change["velocity_deviation"])
    if "release_velocity" in change:
        note.release_velocity = float(change["release_velocity"])


def _note_vector(clip, ids):
    """The note vector Live itself returned, so `apply_note_modifications` accepts it back.

    Live's binding rejects a plain Python list. `get_notes_by_id` returns just the named notes; without
    it the whole extended read is the vector (unnamed notes are written back unchanged)."""
    if hasattr(clip, "get_notes_by_id"):
        return clip.get_notes_by_id(ids)
    return clip_lom.all_notes_vector(clip)


def _notes_modify(ctx, args):
    target, known = _modify_check(ctx, args)
    ids = [change["note_id"] for change in args["notes"]]
    vector = _note_vector(target.clip, ids)
    live_notes = {int(note.note_id): note for note in vector}
    for note_id in ids:
        if note_id not in live_notes:
            raise lom.not_found("note", note_id)
    for change in args["notes"]:
        _apply_note_fields(live_notes[change["note_id"]], change)  # edited in place, inside the vector
    ctx.note_mutation()
    target.clip.apply_note_modifications(vector)
    return {"modified": len(ids)}


def _quantize_check(ctx, args):
    target = clip_lom.midi_target(ctx.song, args["clip"])
    if "pitch" in args and not hasattr(target.clip, "quantize_pitch"):  # assumption A27
        raise _not_supported("live_version", "this Live version cannot quantize a single pitch")
    return target


def _notes_quantize(ctx, args):
    target = _quantize_check(ctx, args)
    grid = clip_lom.grid_value(args["grid"])
    amount = float(args["amount"])
    ctx.note_mutation()
    if "pitch" in args:
        target.clip.quantize_pitch(args["pitch"], grid, amount)
    else:
        target.clip.quantize(grid, amount)
    return {}


# ----------------------------------------------------------------- registration

NOTES_PAGING = {
    "limit": v.with_default(v.integer(min=1, max=5000), 1000),
    "offset": v.with_default(v.integer(min=0), 0),
}
_CLIP = clip_lom.CLIP_REF
_TRACK = lom.TRACK_ONLY_REF
_SLOT = clip_lom.SLOT_INDEX


def install(registry):
    reg = registry.register
    reg(Command("clip_list", v.obj(dict({"track": _TRACK, "include_empty": v.with_default(v.boolean(), False)},
                                        **v.PAGING_PROPS), required=["track"]), _clip_list))
    reg(Command("clip_get", v.obj({"clip": _CLIP}, required=["clip"]), _clip_get))
    reg(Command("slot_status", v.obj({"track": _TRACK, "slot": _SLOT}, required=["track", "slot"]),
                _slot_status))
    reg(Command("clip_create", v.obj({
        "track": _TRACK, "slot": _SLOT, "length": v.number(min=0.25, max=1024), "name": lom.NAME,
        "color": lom.COLOR}, required=["track", "slot", "length"]), _clip_create, mutating=True,
        precheck=_create_check))
    reg(Command("audio_clip_create", v.obj({
        "track": _TRACK, "slot": _SLOT, "position": v.number(min=0),
        "expected_length_beats": v.number(min=0, exclusive_min=True, max=1_000_000),
        "file_path": v.string(max_bytes=clip_lom.MAX_PATH_BYTES), "allow_overwrite": v.boolean(),
    }, required=["track", "file_path"]), _audio_clip_create, mutating=True,
        destructive="conditional", conditions=("allow_overwrite",), prepare=_audio_prepare,
        precheck=_audio_check))
    reg(Command("clip_delete", v.obj({"clip": _CLIP, "expect_name": lom.NAME}, required=["clip"]),
                _clip_delete, mutating=True, destructive="always", precheck=_delete_check))
    reg(Command("clip_duplicate", v.obj({
        "from": clip_lom.SLOT_REF, "to": clip_lom.SLOT_REF,
        "allow_overwrite": v.with_default(v.boolean(), False)}, required=["from"]),
        _clip_duplicate, mutating=True, destructive="conditional", conditions=("allow_overwrite",),
        precheck=_duplicate_check, edition_delta=_duplicate_delta))
    reg(Command("clip_set", v.obj({
        "clip": _CLIP, "name": lom.NAME, "color": lom.COLOR, "muted": v.boolean(), "looping": v.boolean(),
        "loop_start": v.number(min=0, max=1_000_000), "loop_end": v.number(min=0, max=1_000_000),
        "start_marker": v.number(min=0, max=1_000_000), "end_marker": v.number(min=0, max=1_000_000),
        "gain": v.number(min=0, max=1), "pitch_coarse": v.integer(min=-48, max=48),
        "pitch_fine": v.number(min=-50, max=50), "warping": v.boolean()}, required=["clip"]),
        _clip_set, mutating=True, precheck=_set_check))
    reg(Command("clip_crop", v.obj({"clip": _CLIP}, required=["clip"]), _clip_crop, mutating=True,
                destructive="always", precheck=_crop_check))
    reg(Command("clip_duplicate_loop", v.obj({"clip": _CLIP}, required=["clip"]), _clip_duplicate_loop,
                mutating=True, precheck=_loop_check))
    reg(Command("slot_fire", v.obj({
        "track": _TRACK, "slot": _SLOT, "record_length": v.number(min=0.25, max=256),
        "launch_quantization": v.integer(min=0, max=13)}, required=["track", "slot"]),
        _slot_fire, mutating=True, precheck=_slot_fire_check))
    reg(Command("slot_stop", v.obj({"track": _TRACK, "slot": _SLOT}, required=["track", "slot"]),
                _slot_stop, mutating=True, precheck=_slot_stop_check))
    reg(Command("notes_get", v.obj(dict({
        "clip": _CLIP, "from_pitch": v.with_default(v.integer(min=0, max=127), 0),
        "pitch_span": v.with_default(v.integer(min=1, max=128), 128),
        "from_time": v.with_default(v.number(min=clip_lom.NOTE_TIME_MIN), clip_lom.NOTE_TIME_MIN),
        "time_span": v.with_default(v.number(min=0, exclusive_min=True), clip_lom.NOTE_TIME_SPAN)},
        **NOTES_PAGING), required=["clip"]),
        _notes_get))
    reg(Command("notes_add", v.obj({"clip": _CLIP, "notes": v.array(clip_lom.ADD_NOTE, min_items=1,
                                                                    max_items=2000)},
                                   required=["clip", "notes"]), _notes_add, mutating=True,
                precheck=_notes_add_check))
    reg(Command("notes_remove", v.obj({
        "clip": _CLIP, "from_pitch": v.integer(min=0, max=127), "pitch_span": v.integer(min=1, max=128),
        "from_time": v.number(min=clip_lom.NOTE_TIME_MIN), "time_span": v.number(min=0, exclusive_min=True),
        "note_ids": v.array(v.integer(min=0), min_items=1, max_items=2000)},
        required=["clip"], exclusive=[("note_ids", name) for name in _RANGE_FIELDS]),
        _notes_remove, mutating=True, destructive="always", prepare=_remove_prepare,
        precheck=_remove_check))
    reg(Command("notes_modify", v.obj({"clip": _CLIP, "notes": v.array(clip_lom.MODIFY_NOTE, min_items=1,
                                                                       max_items=2000)},
                                      required=["clip", "notes"]), _notes_modify, mutating=True,
                prepare=_modify_prepare, precheck=_modify_check))
    reg(Command("notes_quantize", v.obj({
        "clip": _CLIP, "grid": v.enum(*GRIDS), "amount": v.with_default(v.number(min=0, max=1), 1),
        "pitch": v.integer(min=0, max=127)}, required=["clip", "grid"]),
        _notes_quantize, mutating=True, precheck=_quantize_check))
