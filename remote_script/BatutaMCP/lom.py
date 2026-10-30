"""Shared Live Object Model helpers for the command groups (docs/01-protocol.md sections 6.1-6.3).

Everything here is read-only: reference resolution, info builders for the common result objects,
paging and the volume dB text conversion. No function reaches an attribute through a client
string; every property name is a literal. Reads that Live refuses for some track kinds (for
example `arm` on a return or the master) go through `safe`, which turns the refusal into None.
"""

import math
import re

from . import limits
from . import validator as v
from .errors import BatutaError
from .textutil import clean

NAME = v.string(max_chars=limits.MAX_NAME_CHARS)
COLOR = v.integer(min=0, max=0xFFFFFF)

_EXPECT = {"expect_name": NAME}
TRACK_ONLY_REF = v.obj(dict({"kind": v.enum("track"), "index": v.integer(min=0)}, **_EXPECT),
                       required=["kind", "index"])
TRACK_OR_RETURN_REF = v.obj(dict({"kind": v.enum("track", "return"), "index": v.integer(min=0)}, **_EXPECT),
                            required=["kind", "index"])

_DEVICE_TYPES = {0: "undefined", 1: "instrument", 2: "audio_effect", 4: "midi_effect"}  # Live DeviceType
_DB_TEXT = re.compile(r"^([+-]?\d+(?:[.,]\d+)?)\s*dB$", re.IGNORECASE)
_NEG_INF_TEXT = re.compile(r"^-\s*inf(?:inity)?\s*(?:dB)?$", re.IGNORECASE)
_VERSION_NUMBER = re.compile(r"\d+(?:\.\d+)+")
MAX_LISTED_OPTIONS = 200
CUE_TOLERANCE = 1e-6
# Live toggles (removes) an existing cue near the playhead when set_or_delete_cue runs, using a
# tolerance the LOM does not document. The script keeps this much distance between cues it edits.
# Start value 1e-3 beats; to be tuned by the owner test for assumption A16.
CUE_TOGGLE_WINDOW = 1e-3


# ----------------------------------------------------------------- small helpers

def safe(read, default=None):
    """Result of `read()`, or `default` when Live refuses the property for this kind of object."""
    try:
        return read()
    except (AttributeError, RuntimeError):
        return default


def runs_top_level(ctx, name):
    """True when command `name` is the job itself (not an op inside `batch`), so it may wait for ticks."""
    return getattr(ctx, "command_name", None) == name


def same(first, second):
    """Live hands out a new wrapper per access, so compare with == (identity is a shortcut)."""
    return first is second or (first is not None and second is not None and first == second)


def text(value, max_chars=limits.MAX_NAME_CHARS):
    """A string from Live, control-stripped and capped (spec section 0); other types become ''."""
    return clean(value, max_chars) if isinstance(value, str) else ""


def live_version():
    try:
        import Live
        shown = Live.Application.get_application().get_version_string()
    except Exception:  # Live missing or the API differs: report unknown rather than fail
        return "unknown"
    found = _VERSION_NUMBER.search(shown) if isinstance(shown, str) else None
    return found.group(0) if found else "unknown"


def invalid(reason, message, **details):
    details["reason"] = reason
    return BatutaError("invalid_args", message, details)


def not_found(what, index, reason=None, **details):
    details["what"] = what
    details["index"] = index
    if reason is not None:
        details["reason"] = reason
    return BatutaError("not_found", "%s not found" % what, details)


def out_of_range(field, low, high, value):
    return BatutaError("out_of_range", "%s is outside %s..%s" % (field, low, high),
                       {"field": field, "min": low, "max": high, "value": value})


def nearby_cue(cues, time, skip=None):
    """{name, time} of the first cue within the toggle window of `time` (skipping `skip`), else None."""
    for cue in cues:
        if skip is not None and same(cue, skip):
            continue
        if abs(float(cue.time) - time) <= CUE_TOGGLE_WINDOW:
            return {"name": text(safe(lambda: cue.name)), "time": float(cue.time)}
    return None


def new_items(before, after):
    """Objects present in `after` but not in `before`, in order (== comparison, spec A40).

    Linear when `after` is `before` plus insertions (the usual case); a removal in between falls back
    to comparing every pair."""
    position = 0
    extra = []
    for item in after:
        if position < len(before) and same(item, before[position]):
            position += 1
        else:
            extra.append(item)
    if position == len(before):
        return extra
    return [item for item in after if not any(same(item, old) for old in before)]


def descendants(song, group):
    """Tracks nested at any depth inside the group track `group`.

    Reads strictly: a track whose parent cannot be read raises, so callers can fail closed."""
    members = [group]
    found = []
    grew = True
    while grew:
        grew = False
        for track in song.tracks:
            if any(same(track, known) for known in found):
                continue
            parent = track.group_track
            if parent is not None and any(same(parent, member) for member in members):
                members.append(track)
                found.append(track)
                grew = True
    return found


def is_armed(track):
    """Armable and armed, or armable with an unreadable state (fail closed)."""
    if safe(lambda: track.can_be_armed) is not True:
        return False
    try:
        return track.arm is True
    except RuntimeError:
        return True


# ----------------------------------------------------------------- paging

def page(sequence, args, build):
    """Spec 6.3 list: {items, total, next_offset}; `build(position, element)` runs on the slice only."""
    total = len(sequence)
    start = args["offset"]
    stop = min(total, start + args["limit"])
    items = [build(position, sequence[position]) for position in range(start, stop)]
    return {"items": items, "total": total, "next_offset": stop if stop < total else None}


# ----------------------------------------------------------------- tracks

def track_sequence(song, kind):
    return song.tracks if kind == "track" else song.return_tracks


def resolve_track(song, ref):
    """TrackRef -> Live track. Out of range and `expect_name` mismatches are not_found (spec 6.1)."""
    kind = ref["kind"]
    if kind == "master":
        track, index = song.master_track, None
    else:
        sequence = track_sequence(song, kind)
        index = ref["index"]
        if index >= len(sequence):
            raise not_found(kind, index)
        track = sequence[index]
    expected = ref.get("expect_name")
    if expected is not None and text(safe(lambda: track.name)) != expected:
        raise not_found(kind, index, "name_mismatch")
    return track


def normal_ref(ref):
    """The TrackRef shape used in results (no guard fields)."""
    if ref["kind"] == "master":
        return {"kind": "master"}
    return {"kind": ref["kind"], "index": ref["index"]}


def ref_for(song, track):
    """TrackRef of a Live track found by ==, or None when it is not part of the set."""
    if track is None:
        return None
    for index, candidate in enumerate(song.tracks):
        if same(candidate, track):
            return {"kind": "track", "index": index}
    for index, candidate in enumerate(song.return_tracks):
        if same(candidate, track):
            return {"kind": "return", "index": index}
    if same(song.master_track, track):
        return {"kind": "master"}
    return None


def all_track_entries(song, include_returns=True, include_master=True):
    """[(kind, index, track)] in listing order: tracks, returns, master."""
    entries = [("track", i, t) for i, t in enumerate(song.tracks)]
    if include_returns:
        entries += [("return", i, t) for i, t in enumerate(song.return_tracks)]
    if include_master:
        entries.append(("master", None, song.master_track))
    return entries


def descendant_count(song, group):
    """How many tracks sit (at any depth) inside the group track `group`."""
    members = [group]
    count = 0
    for track in song.tracks:
        parent = safe(lambda: track.group_track)
        if parent is not None and any(same(parent, member) for member in members):
            members.append(track)
            count += 1
    return count


def created_tracks_report(song, created):
    """Result fields for tracks Live created during a load: new_tracks plus landed_on (the first one), or {}."""
    found = []
    for track in created:
        index = position_of(song.tracks, track)
        if index is not None:
            found.append({"kind": "track", "index": index, "name": text(safe(lambda: track.name)),
                          "arm": as_bool(safe(lambda: track.arm))})
    if not found:
        return {}
    return {"new_tracks": found, "landed_on": {"kind": "track", "index": found[0]["index"]}}


def track_info(song, kind, index, track):
    """TrackInfo (spec 6.3); fields that do not apply to the kind are null."""
    colored = kind != "master"
    info = {
        "kind": kind, "index": index, "name": text(safe(lambda: track.name)),
        "color": as_int(safe(lambda: track.color)) if colored else None,
        "mute": as_bool(safe(lambda: track.mute)) if colored else None,
        "solo": as_bool(safe(lambda: track.solo)) if colored else None,
        "arm": None, "can_be_armed": None, "has_midi_input": None, "has_audio_input": None,
        "is_foldable": None, "fold_state": None, "group_track_index": None,
        "monitoring_state": None, "device_count": len(safe(lambda: track.devices, [])),
    }
    if kind == "track":
        foldable = as_bool(safe(lambda: track.is_foldable, False))
        info.update({
            "arm": as_bool(safe(lambda: track.arm)),
            "can_be_armed": as_bool(safe(lambda: track.can_be_armed)),
            "has_midi_input": as_bool(safe(lambda: track.has_midi_input)),
            "has_audio_input": as_bool(safe(lambda: track.has_audio_input)),
            "is_foldable": foldable,
            "fold_state": as_bool(safe(lambda: track.fold_state)) if foldable else None,
            "group_track_index": position_of(song.tracks, safe(lambda: track.group_track)),
            "monitoring_state": as_int(safe(lambda: track.current_monitoring_state)),
        })
    return info


def position_of(sequence, item):
    if item is None:
        return None
    for position, candidate in enumerate(sequence):
        if same(candidate, item):
            return position
    return None


def as_int(value):
    return None if value is None else int(value)


def as_bool(value):
    return None if value is None else bool(value)


def as_float(value):
    return None if value is None else float(value)


def device_info(path, device):
    """DeviceInfo (spec 6.3); `path` is the already built DeviceRef path list."""
    kind = safe(lambda: int(device.type))
    return {
        "path": path, "name": text(safe(lambda: device.name)),
        "class_name": text(safe(lambda: device.class_name)),
        "type": _DEVICE_TYPES.get(kind),
        "is_active": as_bool(safe(lambda: device.is_active)),
        "can_have_chains": as_bool(safe(lambda: device.can_have_chains)),
        "can_have_drum_pads": as_bool(safe(lambda: device.can_have_drum_pads)),
        "parameter_count": len(safe(lambda: device.parameters, [])),
    }


def clip_summary(clip):
    return {
        "name": text(safe(lambda: clip.name)), "color": as_int(safe(lambda: clip.color)),
        "length": as_float(safe(lambda: clip.length)),
        "is_midi": as_bool(safe(lambda: clip.is_midi_clip)),
        "is_audio": as_bool(safe(lambda: clip.is_audio_clip)),
        "looping": as_bool(safe(lambda: clip.looping)), "muted": as_bool(safe(lambda: clip.muted)),
    }


def slot_info(track_ref, position, slot):
    has_clip = bool(safe(lambda: slot.has_clip, False))
    return {
        "track": track_ref, "slot": position, "has_clip": has_clip,
        "is_playing": bool(safe(lambda: slot.is_playing, False)),
        "is_recording": bool(safe(lambda: slot.is_recording, False)),
        "is_triggered": bool(safe(lambda: slot.is_triggered, False)),
        "clip": clip_summary(slot.clip) if has_clip else None,
    }


# ----------------------------------------------------------------- scenes

def resolve_scene(song, index, expect_name=None):
    if index >= len(song.scenes):
        raise not_found("scene", index)
    scene = song.scenes[index]
    if expect_name is not None and text(safe(lambda: scene.name)) != expect_name:
        raise not_found("scene", index, "name_mismatch")
    return scene


def scene_info(index, scene):
    tempo_on = safe(lambda: scene.tempo_enabled)
    tempo = as_float(safe(lambda: scene.tempo))
    if tempo_on is None:  # older Live: a non-positive tempo means "not set"
        tempo_on = tempo is not None and tempo > 0
    sig_on = safe(lambda: scene.time_signature_enabled)
    numerator = safe(lambda: scene.time_signature_numerator)
    denominator = safe(lambda: scene.time_signature_denominator)
    if sig_on is None:
        sig_on = numerator is not None and numerator > 0
    return {
        "index": index, "name": text(safe(lambda: scene.name)),
        "color": as_int(safe(lambda: scene.color)),
        "tempo": tempo if tempo_on else None,
        "time_signature": [int(numerator), int(denominator)] if sig_on and numerator is not None
        and denominator is not None else None,
        "is_triggered": bool(safe(lambda: scene.is_triggered, False)),
    }


# ----------------------------------------------------------------- parameters and dB text

def parse_db(display):
    """dB value of a Live display string: float, -inf for '-inf dB', None when not derivable."""
    if not isinstance(display, str):
        return None
    shown = display.replace("−", "-").strip()
    if _NEG_INF_TEXT.match(shown):
        return -math.inf
    found = _DB_TEXT.match(shown)
    if found is None:
        return None
    return float(found.group(1).replace(",", "."))


def param_json(param):
    """{value, min, max, display} of a DeviceParameter (spec 6.2)."""
    value = param.value
    return {"value": float(value), "min": float(param.min), "max": float(param.max),
            "display": text(param.str_for_value(value), 64)}


def volume_json(param):
    result = param_json(param)
    db = parse_db(result["display"])
    result["volume_db"] = db if db is not None and math.isfinite(db) else None
    return result


def checked_value(field, param, value):
    """Range check against the live min/max; out-of-range is an error, never clamped."""
    low, high = float(param.min), float(param.max)
    if not low <= value <= high:
        raise out_of_range(field, low, high, value)
    return value


def raw_for_db(param, target_db):
    """Bisection over `str_for_value` (<= 24 iterations) mapping a dB target to a raw value."""
    low, high = float(param.min), float(param.max)
    top = parse_db(param.str_for_value(high))
    if top is None or top == -math.inf:
        raise invalid("db_unavailable", "volume_db cannot be derived from this display text")
    if target_db > top + 0.05:
        raise out_of_range("volume_db", -70, top, target_db)
    for _ in range(24):
        middle = (low + high) / 2.0
        shown = parse_db(param.str_for_value(middle))
        if shown is None:
            raise invalid("db_unavailable", "volume_db cannot be derived from this display text")
        if shown < target_db:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0
