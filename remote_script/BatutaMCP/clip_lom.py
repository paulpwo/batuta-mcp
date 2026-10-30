"""Clip helpers shared by the clip, envelope and arrangement command groups (spec 6.1, 6.3, 7.6-7.11).

Reference resolution and result builders only: nothing here writes to the Live Object Model. Every
property name is a literal; client data never selects an attribute. `note_specs` and `grid_value`
are the two places that ask Live's own module for enum/constructor objects, with literal names.
"""

from . import limits
from . import lom
from . import validator as v

SLOT_INDEX = v.integer(min=0)
START_TOLERANCE = 1e-6  # expect_start guard (spec 6.1)
OVERLAP_EPSILON = 1e-6  # clips that only touch do not overlap
MAX_OVERLAP_DETAILS = 10
NOTE_TIME_MIN = -1.0e6  # default note window start: covers notes before the start marker
NOTE_TIME_SPAN = 2.0e6  # default note window length: covers notes outside the loop
MAX_PATH_BYTES = 1024
AUDIO_EXTENSIONS = (".wav", ".aif", ".aiff", ".flac", ".mp3")
HEADER_EXTENSIONS = (".wav", ".aif", ".aiff")  # formats whose length the server derives from the header

# ----------------------------------------------------------------- schemas

SLOT_REF = v.obj({"track": lom.TRACK_ONLY_REF, "slot": SLOT_INDEX}, required=["track", "slot"])
CLIP_REF = v.one_of(
    v.obj({"kind": v.enum("session"), "track": lom.TRACK_ONLY_REF, "slot": SLOT_INDEX},
          required=["kind", "track", "slot"]),
    v.obj({"kind": v.enum("arrangement"), "track": lom.TRACK_ONLY_REF, "index": v.integer(min=0),
           "expect_start": v.number()}, required=["kind", "track", "index"]),
)

# One note as the client sends it (spec 7.6 notes_add); modify uses the same fields, all optional.
_NOTE_VALUES = {
    "pitch": v.integer(min=0, max=127),
    "start_time": v.number(min=0),
    "duration": v.number(min=0, exclusive_min=True),
    "velocity": v.number(min=1, max=127),
    "mute": v.boolean(),
    "probability": v.number(min=0, max=1),
    "velocity_deviation": v.number(min=-127, max=127),
    "release_velocity": v.number(min=0, max=127),
}
_NOTE_DEFAULTS = {"velocity": 100, "mute": False, "probability": 1, "velocity_deviation": 0,
                  "release_velocity": 64}
ADD_NOTE = v.obj({name: (v.with_default(schema, _NOTE_DEFAULTS[name]) if name in _NOTE_DEFAULTS else schema)
                  for name, schema in _NOTE_VALUES.items()},
                 required=["pitch", "start_time", "duration"])
MODIFY_NOTE = v.obj(dict({"note_id": v.integer(min=0)}, **_NOTE_VALUES), required=["note_id"])
NOTE_FIELDS = tuple(_NOTE_VALUES)


# ----------------------------------------------------------------- small readers

def has_clip(slot):
    return bool(lom.safe(lambda: slot.has_clip, False))


def is_midi_track(track):
    return lom.safe(lambda: track.has_midi_input) is True


def is_audio_track(track):
    return lom.safe(lambda: track.has_audio_input) is True


def is_midi_clip(clip):
    return bool(lom.safe(lambda: clip.is_midi_clip, False))


def is_audio_clip(clip):
    return bool(lom.safe(lambda: clip.is_audio_clip, False))


def session_slots(track):
    return lom.safe(lambda: list(track.clip_slots), [])


def arrangement_clips(track):
    return lom.safe(lambda: list(track.arrangement_clips), [])


# ----------------------------------------------------------------- resolution

class ClipTarget:
    """A resolved ClipRef: the Live clip, its track and where it lives (slot or arrangement index)."""

    def __init__(self, kind, track, track_ref, position, clip, slot=None):
        self.kind = kind
        self.track = track
        self.track_ref = track_ref
        self.position = position
        self.clip = clip
        self.slot = slot


def resolve_slot(song, track_ref, index):
    """(track, slot) for a SlotRef; an index past the last slot is not_found."""
    track = lom.resolve_track(song, track_ref)
    slots = session_slots(track)
    if index >= len(slots):
        raise lom.not_found("slot", index)
    return track, slots[index]


def resolve_clip(song, ref, expect_name=None):
    """ClipRef -> ClipTarget. Missing clip, shifted arrangement start and name mismatch are not_found."""
    track = lom.resolve_track(song, ref["track"])
    shown = lom.normal_ref(ref["track"])
    if ref["kind"] == "session":
        index = ref["slot"]
        slots = session_slots(track)
        if index >= len(slots):
            raise lom.not_found("slot", index)
        slot = slots[index]
        if not has_clip(slot):
            raise lom.not_found("clip", index, "empty_slot")
        target = ClipTarget("session", track, shown, index, slot.clip, slot)
    else:
        index = ref["index"]
        clips = arrangement_clips(track)
        if index >= len(clips):
            raise lom.not_found("clip", index)
        expected = ref.get("expect_start")
        if expected is not None and abs(float(clips[index].start_time) - expected) > START_TOLERANCE:
            raise lom.not_found("clip", index, "start_mismatch")
        target = ClipTarget("arrangement", track, shown, index, clips[index])
    if expect_name is not None and lom.text(lom.safe(lambda: target.clip.name)) != expect_name:
        raise lom.not_found("clip", target.position, "name_mismatch")
    return target


def midi_target(song, ref):
    """Resolve a ClipRef that must name a MIDI clip."""
    target = resolve_clip(song, ref)
    if not is_midi_clip(target.clip):
        raise lom.invalid("not_midi_clip", "this command needs a MIDI clip")
    return target


def arrangement_target(track, track_ref, clip):
    """ClipTarget of an arrangement clip found by == in the track's current list, or None."""
    position = lom.position_of(arrangement_clips(track), clip)
    if position is None:
        return None
    return ClipTarget("arrangement", track, track_ref, position, clip)


# ----------------------------------------------------------------- results

def clip_info(target):
    """ClipInfo (spec 6.3). Audio-only fields are null for MIDI clips."""
    clip = target.clip
    audio = is_audio_clip(clip)
    info = lom.clip_summary(clip)
    numerator = lom.safe(lambda: clip.signature_numerator)
    denominator = lom.safe(lambda: clip.signature_denominator)
    path = lom.safe(lambda: clip.file_path) if audio else None
    info.update({
        "kind": target.kind, "track": target.track_ref, "slot_or_index": target.position,
        "start_time": lom.as_float(lom.safe(lambda: clip.start_time)),
        "end_time": lom.as_float(lom.safe(lambda: clip.end_time)),
        "loop_start": lom.as_float(lom.safe(lambda: clip.loop_start)),
        "loop_end": lom.as_float(lom.safe(lambda: clip.loop_end)),
        "start_marker": lom.as_float(lom.safe(lambda: clip.start_marker)),
        "end_marker": lom.as_float(lom.safe(lambda: clip.end_marker)),
        "signature": [int(numerator), int(denominator)] if numerator is not None and denominator is not None
        else None,
        "is_playing": bool(lom.safe(lambda: clip.is_playing, False)),
        "is_recording": bool(lom.safe(lambda: clip.is_recording, False)),
        "file_path": lom.text(path, limits.MAX_STRING_BYTES) if isinstance(path, str) else None,
        "sample_rate": lom.as_int(lom.safe(lambda: clip.sample_rate)) if audio else None,
        "gain": lom.as_float(lom.safe(lambda: clip.gain)) if audio else None,
        "pitch_coarse": lom.as_int(lom.safe(lambda: clip.pitch_coarse)) if audio else None,
        "pitch_fine": lom.as_float(lom.safe(lambda: clip.pitch_fine)) if audio else None,
        "warping": lom.as_bool(lom.safe(lambda: clip.warping)) if audio else None,
    })
    return info


def session_target(track, track_ref, index, slot):
    return ClipTarget("session", track, track_ref, index, slot.clip, slot)


# ----------------------------------------------------------------- arrangement overlap

def clip_span(clip):
    """(start, end) of an arrangement clip on the timeline; a stretched loop is longer than its loop."""
    return float(clip.start_time), float(clip.end_time)


def new_clip_extent(clip):
    """Beats a copy of `clip` takes on the timeline: an arrangement clip keeps its (stretched) extent,
    a session clip takes its length. Fails toward the stricter answer: an unreadable arrangement flag
    counts as an arrangement clip, and the larger of loop length and extent wins."""
    length = float(clip.length)
    if lom.safe(lambda: clip.is_arrangement_clip, True) is False:
        return length
    try:
        start, end = clip_span(clip)
    except (AttributeError, RuntimeError, TypeError):
        return length
    return max(length, end - start)


def find_created(track, before, start):
    """The arrangement clip that begins at `start` and was not in `before` (compared with ==), or None."""
    for clip in arrangement_clips(track):
        if abs(float(clip.start_time) - start) <= START_TOLERANCE \
                and not any(lom.same(clip, old) for old in before):
            return clip
    return None


def overlapping(clips, start, end):
    """Existing arrangement clips that intersect [start, end); clips that only touch do not count."""
    found = []
    for index, clip in enumerate(clips):
        clip_start, clip_end = clip_span(clip)
        if clip_start < end - OVERLAP_EPSILON and clip_end > start + OVERLAP_EPSILON:
            found.append({"index": index, "name": lom.text(lom.safe(lambda: clip.name)),
                          "start_time": clip_start, "end_time": clip_end})
    return found


def overlap_error(found, **extra):
    return lom.invalid("overlap", "the new clip would overlap existing arrangement clips",
                       clips=found[:MAX_OVERLAP_DETAILS], overlap_count=len(found), **extra)


# ----------------------------------------------------------------- notes

def note_json(note):
    return {
        "note_id": int(note.note_id), "pitch": int(note.pitch), "start_time": float(note.start_time),
        "duration": float(note.duration), "velocity": float(note.velocity), "mute": bool(note.mute),
        "probability": float(note.probability), "velocity_deviation": float(note.velocity_deviation),
        "release_velocity": float(note.release_velocity),
    }


def all_notes_vector(clip):
    """Every note of a MIDI clip exactly as Live returned it (not copied into a Python list)."""
    if hasattr(clip, "get_all_notes_extended"):
        return clip.get_all_notes_extended()
    return clip.get_notes_extended(0, 128, NOTE_TIME_MIN, NOTE_TIME_SPAN)


def all_notes(clip):
    """Every note of a MIDI clip as extended-API note objects (snapshots)."""
    return list(all_notes_vector(clip))


def note_values(note):
    """The client's note dict as plain typed values for Live (explicit fields, no passthrough)."""
    return {
        "pitch": int(note["pitch"]), "start_time": float(note["start_time"]),
        "duration": float(note["duration"]), "velocity": float(note["velocity"]),
        "mute": bool(note["mute"]), "probability": float(note["probability"]),
        "velocity_deviation": float(note["velocity_deviation"]),
        "release_velocity": float(note["release_velocity"]),
    }


def note_specs(notes):
    """Note specifications for add_new_notes: Live's MidiNoteSpecification when the module has it,
    else plain dicts (assumption A12)."""
    values = [note_values(note) for note in notes]
    try:
        import Live
        factory = Live.Clip.MidiNoteSpecification
    except (ImportError, AttributeError):
        return tuple(values)
    return tuple(factory(**item) for item in values)


def grid_value(grid):
    """Clip.quantize grid for "1/4".."1/32": Live.Song.RecordingQuantization when present, else the
    fixed integers (assumption A13; Clip.GridQuantization is not what quantize takes)."""
    fallback = {"1/4": 1, "1/8": 2, "1/16": 5, "1/32": 8}
    try:
        import Live
        enum = Live.Song.RecordingQuantization
    except (ImportError, AttributeError):
        return fallback[grid]
    names = {
        "1/4": lambda: getattr(enum, "rec_q_quarter", None),
        "1/8": lambda: getattr(enum, "rec_q_eight", None),
        "1/16": lambda: getattr(enum, "rec_q_sixtenth", None),
        "1/32": lambda: getattr(enum, "rec_q_thirtysecond", None),
    }
    found = names[grid]()
    return fallback[grid] if found is None else found


# ----------------------------------------------------------------- audio file path (spec 7.6)

def check_audio_path(path):
    """Lexical checks only: absolute, no '..' component, no NUL, <= 1024 bytes, allowed extension."""
    if "\x00" in path:
        raise lom.invalid("path_nul", "file_path must not contain NUL")
    if len(path.encode("utf-8", "surrogatepass")) > MAX_PATH_BYTES:
        raise lom.invalid("path_too_long", "file_path is longer than %d bytes" % MAX_PATH_BYTES)
    if not path.startswith("/"):
        raise lom.invalid("path_not_absolute", "file_path must be absolute")
    if ".." in path.split("/"):
        raise lom.invalid("path_traversal", "file_path must not contain '..'")
    name = path.rsplit("/", 1)[-1].lower()
    if not name.endswith(AUDIO_EXTENSIONS):
        raise lom.invalid("extension", "file_path must end in %s" % ", ".join(AUDIO_EXTENSIONS))
    return name
