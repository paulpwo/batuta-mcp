"""Session, transport and undo/redo commands (docs/01-protocol.md sections 7.1 and 7.13).

`catalog` and `batch` live in core_commands. Every setter below is a literal property write; the
recording-safety guards of section 5.6 run in the precheck hook (before the undo step) and again
at the start of the handler, so they also hold per op inside `batch`.
"""

from . import lom
from . import validator as v
from .dispatcher import NEXT_TICK
from .errors import BatutaError
from .registry import Command

_SCALE_ERRORS = (RuntimeError, ValueError, TypeError)
_RECORD_FIELDS = ("record_mode", "session_record", "arrangement_overdub")

# Song.clip_trigger_quantization, Live.Song.Quantization order [A]: index == enum value.
QUANTIZATION_LABELS = ("none", "8 bars", "4 bars", "2 bars", "1 bar", "1/2", "1/2T", "1/4", "1/4T",
                       "1/8", "1/8T", "1/16", "1/16T", "1/32")
_QUANTIZATION_INDEX = {label: index for index, label in enumerate(QUANTIZATION_LABELS)}

SONG_SET_SCHEMA = v.obj({
    "tempo": v.number(min=20, max=999),
    "signature_numerator": v.integer(min=1, max=99),
    "signature_denominator": v.enum(1, 2, 4, 8, 16),
    "metronome": v.boolean(), "loop": v.boolean(),
    "loop_start": v.number(min=0), "loop_length": v.number(min=0, exclusive_min=True),
    "record_mode": v.boolean(), "arrangement_overdub": v.boolean(), "session_record": v.boolean(),
    "clip_trigger_quantization": v.one_of(v.integer(min=0, max=len(QUANTIZATION_LABELS) - 1),
                                          v.enum(*QUANTIZATION_LABELS)),
    "root_note": v.integer(min=0, max=11), "scale_name": v.string(max_chars=64),
}, at_least_one=True)


# ----------------------------------------------------------------- reads

def _quantization(song):
    """{index, label} of the global clip trigger quantization, or None when Live lacks it."""
    index = lom.safe(lambda: int(song.clip_trigger_quantization))
    if index is None:
        return None
    label = QUANTIZATION_LABELS[index] if 0 <= index < len(QUANTIZATION_LABELS) else None
    return {"index": index, "label": label}


def song_info(ctx, args):
    song = ctx.song
    return {
        "tempo": float(song.tempo),
        "signature": [int(song.signature_numerator), int(song.signature_denominator)],
        "is_playing": bool(song.is_playing), "current_song_time": float(song.current_song_time),
        "loop": {"on": bool(song.loop), "start": float(song.loop_start),
                 "length": float(song.loop_length)},
        "metronome": bool(song.metronome), "record_mode": bool(song.record_mode),
        "arrangement_overdub": bool(song.arrangement_overdub),
        "session_record": bool(song.session_record),
        "root_note": int(song.root_note), "scale_name": lom.text(song.scale_name, 64),
        "clip_trigger_quantization": _quantization(song),
        "track_count": len(song.tracks), "return_count": len(song.return_tracks),
        "scene_count": len(song.scenes), "cue_count": len(song.cue_points),
        "can_undo": bool(song.can_undo), "can_redo": bool(song.can_redo),
        "selected_track": lom.ref_for(song, song.view.selected_track),
        "live_version": lom.live_version(),
        "pending_sweeps": len(ctx.state.sweeps), "recent_sweeps": ctx.state.recent_sweeps(),
        # The script's own rule for "an external input is live" (docs/01-protocol.md 5.6), with the ids an
        # acknowledgement is bound to: "t<i>" tracks, "r<i>" returns, "m" master.
        "external_live_tracks": [{"id": track_id, "name": lom.text(name, 64)}
                                 for track_id, name in ctx.recording.external_live_entries()][:128],
    }


def undo_state(ctx, args):
    return {"can_undo": bool(ctx.song.can_undo), "can_redo": bool(ctx.song.can_redo)}


# ----------------------------------------------------------------- song_set

def _song_set_check(ctx, args):
    if any(args.get(field) is True for field in _RECORD_FIELDS):
        ctx.recording.check_record_start("song_set")  # rule 4: enabling a record flag


def _song_set(ctx, args):
    _song_set_check(ctx, args)
    song = ctx.song
    ctx.note_mutation()
    applied = []
    if "tempo" in args:
        song.tempo = args["tempo"]
        applied.append("tempo")
    if "signature_numerator" in args:
        song.signature_numerator = args["signature_numerator"]
        applied.append("signature_numerator")
    if "signature_denominator" in args:
        song.signature_denominator = args["signature_denominator"]
        applied.append("signature_denominator")
    if "metronome" in args:
        song.metronome = args["metronome"]
        applied.append("metronome")
    if "loop_start" in args:
        song.loop_start = args["loop_start"]
        applied.append("loop_start")
    if "loop_length" in args:
        song.loop_length = args["loop_length"]
        applied.append("loop_length")
    if "loop" in args:
        song.loop = args["loop"]
        applied.append("loop")
    if "clip_trigger_quantization" in args:
        value = args["clip_trigger_quantization"]
        song.clip_trigger_quantization = _QUANTIZATION_INDEX[value] if type(value) is str else value
        applied.append("clip_trigger_quantization")
    if "root_note" in args:
        song.root_note = args["root_note"]
        applied.append("root_note")
    if "scale_name" in args:
        try:
            song.scale_name = args["scale_name"]
        except _SCALE_ERRORS:
            raise BatutaError("invalid_args", "unknown scale name",
                              {"reason": "unknown_scale", "partial": bool(applied)})
        applied.append("scale_name")
    if "record_mode" in args:
        song.record_mode = args["record_mode"]
        applied.append("record_mode")
    if "session_record" in args:
        song.session_record = args["session_record"]
        applied.append("session_record")
    if "arrangement_overdub" in args:
        song.arrangement_overdub = args["arrangement_overdub"]
        applied.append("arrangement_overdub")
    return {"applied": applied}


# ----------------------------------------------------------------- transport and simple actions

def _transport_check(ctx, args):
    if args["action"] in ("start", "continue"):
        ctx.recording.check_playback_while_recording(ctx.song)  # rule 4 tail


def _transport_write(song, action):
    if action == "start":
        song.start_playing()
    elif action == "continue":
        song.continue_playing()
    else:
        song.stop_playing()


def _transport_state(song):
    return {"is_playing": bool(song.is_playing), "current_song_time": float(song.current_song_time)}


def _transport_deferred(ctx, args):
    """Write, then answer on Live's next tick: `is_playing` only changes after the write is processed."""
    _transport_check(ctx, args)
    song = ctx.song
    ctx.note_mutation()
    song.begin_undo_step()
    try:
        _transport_write(song, args["action"])
    finally:
        song.end_undo_step()
    yield NEXT_TICK
    return _transport_state(song)


def _transport(ctx, args):
    if lom.runs_top_level(ctx, "transport"):
        return _transport_deferred(ctx, args)
    # Inside `batch` there is no tick to wait for: the reply shows the state before Live applied it.
    _transport_check(ctx, args)
    ctx.note_mutation()
    _transport_write(ctx.song, args["action"])
    return _transport_state(ctx.song)


def _song_set_time_deferred(ctx, args):
    """Write, then answer on Live's next tick: the playhead write lands after the handler returns."""
    song = ctx.song
    ctx.note_mutation()
    song.begin_undo_step()
    try:
        song.current_song_time = args["time"]
    finally:
        song.end_undo_step()
    yield NEXT_TICK
    return {"current_song_time": float(song.current_song_time)}


def _song_set_time(ctx, args):
    if lom.runs_top_level(ctx, "song_set_time"):
        return _song_set_time_deferred(ctx, args)
    # Inside `batch` there is no tick to wait for: the reply shows the playhead before Live applied it.
    ctx.note_mutation()
    ctx.song.current_song_time = args["time"]
    return {"current_song_time": float(ctx.song.current_song_time)}


def _stop_all_clips(ctx, args):
    ctx.note_mutation()
    ctx.song.stop_all_clips(args["quantized"])
    return {}


def _back_to_arranger(ctx, args):
    ctx.note_mutation()
    ctx.song.back_to_arranger = False  # assumption: the property is the "Back to Arrangement" state
    return {}


def _capture_midi(ctx, args):
    ctx.note_mutation()
    ctx.song.capture_midi()
    return {}


def _re_enable_automation(ctx, args):
    ctx.note_mutation()
    ctx.song.re_enable_automation()
    return {}


def _trigger_check(ctx, args):
    ctx.recording.check_record_start("trigger_session_record")


def _trigger_session_record(ctx, args):
    _trigger_check(ctx, args)
    ctx.note_mutation()
    if "record_length" in args:
        ctx.song.trigger_session_record(args["record_length"])
    else:
        ctx.song.trigger_session_record()
    return {}


# ----------------------------------------------------------------- undo and redo

def _undo(ctx, args):
    song = ctx.song
    done = 0
    while done < args["steps"] and song.can_undo:
        ctx.note_mutation()
        song.undo()
        done += 1
    return {"undone": done, "can_undo": bool(song.can_undo), "can_redo": bool(song.can_redo)}


def _redo(ctx, args):
    song = ctx.song
    done = 0
    while done < args["steps"] and song.can_redo:
        ctx.note_mutation()
        song.redo()
        done += 1
    return {"redone": done, "can_undo": bool(song.can_undo), "can_redo": bool(song.can_redo)}


STEPS_SCHEMA = v.obj({"steps": v.with_default(v.integer(min=1, max=10), 1)})


def install(registry):
    reg = registry.register
    empty = v.obj({})
    reg(Command("song_info", empty, song_info))
    reg(Command("song_set", SONG_SET_SCHEMA, _song_set, mutating=True, precheck=_song_set_check))
    reg(Command("transport", v.obj({"action": v.enum("start", "continue", "stop")}, required=["action"]),
                _transport, mutating=True, undo_wrapped=False, precheck=_transport_check))
    reg(Command("song_set_time", v.obj({"time": v.number(min=0)}, required=["time"]),
                _song_set_time, mutating=True, undo_wrapped=False))
    reg(Command("stop_all_clips", v.obj({"quantized": v.with_default(v.boolean(), True)}),
                _stop_all_clips, mutating=True))
    reg(Command("back_to_arranger", empty, _back_to_arranger, mutating=True))
    reg(Command("capture_midi", empty, _capture_midi, mutating=True))
    reg(Command("trigger_session_record",
                v.obj({"record_length": v.number(min=1, max=256)}),
                _trigger_session_record, mutating=True, precheck=_trigger_check))
    reg(Command("re_enable_automation", empty, _re_enable_automation, mutating=True))
    reg(Command("undo_state", empty, undo_state))
    # undo/redo are mutating but never wrapped in an undo step (spec 5.3).
    reg(Command("undo", STEPS_SCHEMA, _undo, mutating=True, undo_wrapped=False,
                destructive="conditional", conditions=("steps",)))
    reg(Command("redo", STEPS_SCHEMA, _redo, mutating=True, undo_wrapped=False))
