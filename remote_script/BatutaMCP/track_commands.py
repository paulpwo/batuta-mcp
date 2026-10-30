"""Track commands and meters (docs/01-protocol.md sections 7.2 and 7.14).

Each mutating command has a `check` function that resolves references and runs the edition and
recording-safety guards without touching the Live Object Model. It is installed as the precheck
(so a refusal never opens an undo step) and called again by the handler (so the same guards hold
per op inside `batch`). `ctx.note_mutation()` comes right before the first write.
"""

from . import lom
from . import validator as v
from .errors import BatutaError
from .registry import Command

_TRACK_SET_FIELDS = ("name", "color", "mute", "solo", "fold_state", "monitoring_state", "arm")


# ----------------------------------------------------------------- reads

def _track_list(ctx, args):
    song = ctx.song
    entries = lom.all_track_entries(song, args["include_returns"], args["include_master"])
    return lom.page(entries, args, lambda _, entry: lom.track_info(song, entry[0], entry[1], entry[2]))


def _track_get(ctx, args):
    song = ctx.song
    ref = args["track"]
    track = lom.resolve_track(song, ref)
    kind = ref["kind"]
    index = ref.get("index")
    devices = [lom.device_info([position], device)
               for position, device in enumerate(lom.safe(lambda: list(track.devices), []))]
    slots = None
    if args["include_clips"] and kind == "track":
        shown = lom.normal_ref(ref)
        slots = [lom.slot_info(shown, position, slot)
                 for position, slot in enumerate(lom.safe(lambda: list(track.clip_slots), [])[:500])]
    return {"track": lom.track_info(song, kind, index, track), "devices": devices, "slots": slots}


def _meters_prepare(args, registry):
    if ("tracks" in args) == (args.get("all") is True):
        raise lom.invalid("selector", "give either tracks or all:true")
    return args


def _meters_get(ctx, args):
    song = ctx.song
    if "tracks" in args:
        entries = []
        for ref in args["tracks"]:
            track = lom.resolve_track(song, ref)
            entries.append((lom.normal_ref(ref), track))
    else:
        entries = [(lom.normal_ref({"kind": kind, "index": index}), track)
                   for kind, index, track in lom.all_track_entries(song)]
    return {"meters": [{
        "track": shown,
        "left": lom.as_float(lom.safe(lambda: track.output_meter_left)),
        "right": lom.as_float(lom.safe(lambda: track.output_meter_right)),
        "level": lom.as_float(lom.safe(lambda: track.output_meter_level)),
    } for shown, track in entries]}


# ----------------------------------------------------------------- track_create

def _create_check(ctx, args):
    song = ctx.song
    kind = args["type"]
    name = args.get("name")
    ears = args.get("ears_internal", False)
    if ears and kind != "audio":
        raise lom.invalid("ears_requires_audio", "the ears track must be an audio track")
    ctx.recording.precheck_ears_track(name, ears)  # reserved name and single ears track (5.6)
    if kind == "return":
        ctx.edition.check("returns", len(song.return_tracks))
        return
    count = len(song.tracks)
    if args["index"] > count:
        raise lom.out_of_range("index", -1, count, args["index"])
    ctx.edition.check("tracks", count)


def _track_create(ctx, args):
    _create_check(ctx, args)
    song = ctx.song
    kind = args["type"]
    index = args["index"]
    ctx.note_mutation()
    if kind == "return":
        song.create_return_track()
        track = song.return_tracks[-1]
        shown_kind, shown_index = "return", len(song.return_tracks) - 1
    else:
        if kind == "midi":
            song.create_midi_track(index)
        else:
            song.create_audio_track(index)
        shown_index = len(song.tracks) - 1 if index < 0 else index
        track = song.tracks[shown_index]
        shown_kind = "track"
    if args.get("ears_internal", False):
        ctx.recording.register_ears_track(track, args["name"], True)
    if "name" in args:
        track.name = args["name"]
    if "color" in args:
        track.color = args["color"]
    return {"track": lom.track_info(song, shown_kind, shown_index, track)}


def _create_delta(args):
    return {"returns": 1} if args["type"] == "return" else {"tracks": 1}


# ----------------------------------------------------------------- track_delete / track_duplicate

def _delete_check(ctx, args):
    ref = args["track"]
    track = lom.resolve_track(ctx.song, ref)
    expected = args.get("expect_name")
    if expected is not None and lom.text(lom.safe(lambda: track.name)) != expected:
        raise lom.not_found(ref["kind"], ref["index"], "name_mismatch")
    return track


def _track_delete(ctx, args):
    track = _delete_check(ctx, args)
    ref = args["track"]
    deleted = {"kind": ref["kind"], "index": ref["index"], "name": lom.text(lom.safe(lambda: track.name))}
    ctx.note_mutation()
    if ref["kind"] == "track":
        ctx.song.delete_track(ref["index"])
    else:
        ctx.song.delete_return_track(ref["index"])
    return {"deleted": deleted}


def _delete_delta(args):
    return {"returns": -1} if args["track"]["kind"] == "return" else {"tracks": -1}


def _duplicate_check(ctx, args):
    song = ctx.song
    track = lom.resolve_track(song, args["track"])
    ctx.recording.check_duplicate(track)  # rule 6
    # A duplicated group track also copies its children (assumption A33).
    ctx.edition.check("tracks", len(song.tracks), adding=1 + lom.descendant_count(song, track))
    return track


def _track_duplicate(ctx, args):
    track = _duplicate_check(ctx, args)
    song = ctx.song
    before = list(song.tracks)
    ctx.note_mutation()
    song.duplicate_track(args["track"]["index"])
    after = list(song.tracks)
    created = lom.new_items(before, after)
    if not created:
        raise BatutaError("lom_error", "duplicate_track created no track",
                          {"exception": "NoNewTrack", "partial": True})
    position = lom.position_of(after, created[0])
    return {"track": lom.track_info(song, "track", position, created[0]), "created": len(created)}


# ----------------------------------------------------------------- track_set

def _set_check(ctx, args):
    ref = args["track"]
    kind = ref["kind"]
    track = lom.resolve_track(ctx.song, ref)
    if kind == "master":
        raise lom.invalid("master_not_settable", "the master track accepts no fields here; use mixer_set")
    if not any(field in args for field in _TRACK_SET_FIELDS):
        raise lom.invalid("at_least_one", "give at least one field to change")
    if "name" in args:
        ctx.recording.check_track_name(args["name"], False)
    if "fold_state" in args and not (kind == "track" and lom.safe(lambda: track.is_foldable) is True):
        raise lom.invalid("not_foldable", "only group tracks can be folded")
    if "monitoring_state" in args:
        if kind != "track":
            raise lom.invalid("no_monitoring", "return tracks have no monitoring state")
        ctx.recording.check_monitoring(track, args["monitoring_state"])
    if "arm" in args:
        if args["arm"]:
            ctx.recording.check_arm(track)  # rule 1
        elif lom.safe(lambda: track.can_be_armed) is not True:
            raise lom.invalid("not_armable", "this track cannot be armed")
    return track


def _track_set(ctx, args):
    track = _set_check(ctx, args)
    ctx.note_mutation()
    if "name" in args:
        track.name = args["name"]
    if "color" in args:
        track.color = args["color"]
    if "mute" in args:
        track.mute = args["mute"]
    if "solo" in args:
        track.solo = args["solo"]
    if "fold_state" in args:
        track.fold_state = args["fold_state"]
    if "monitoring_state" in args:
        track.current_monitoring_state = args["monitoring_state"]
    if "arm" in args:
        track.arm = args["arm"]
    ref = args["track"]
    return {"track": lom.track_info(ctx.song, ref["kind"], ref["index"], track)}


# ----------------------------------------------------------------- track_select / track_stop_clips

def _track_select(ctx, args):
    track = lom.resolve_track(ctx.song, args["track"])
    ctx.note_mutation()
    ctx.song.view.selected_track = track
    return {"selected_track": lom.normal_ref(args["track"])}


def _track_stop_clips(ctx, args):
    track = lom.resolve_track(ctx.song, args["track"])
    ctx.note_mutation()
    track.stop_all_clips()
    return {}


# ----------------------------------------------------------------- registration

def _resolve_only(ctx, args):
    lom.resolve_track(ctx.song, args["track"])


def install(registry):
    reg = registry.register
    ref = v.TRACK_REF
    reg(Command("track_list", v.obj(dict({"include_returns": v.with_default(v.boolean(), True),
                                          "include_master": v.with_default(v.boolean(), True)},
                                         **v.PAGING_PROPS)), _track_list))
    reg(Command("track_get", v.obj({"track": ref, "include_clips": v.with_default(v.boolean(), False)},
                                   required=["track"]), _track_get))
    reg(Command("track_create", v.obj({
        "type": v.enum("midi", "audio", "return"),
        "index": v.with_default(v.integer(min=-1), -1), "name": lom.NAME, "color": lom.COLOR,
        "ears_internal": v.boolean(),  # server-only flag (spec 5.6); never exposed as an MCP arg
    }, required=["type"]), _track_create, mutating=True, precheck=_create_check,
        edition_delta=_create_delta))
    reg(Command("track_delete", v.obj({"track": lom.TRACK_OR_RETURN_REF, "expect_name": lom.NAME},
                                      required=["track"]), _track_delete, mutating=True,
                destructive="always", precheck=_delete_check, edition_delta=_delete_delta))
    reg(Command("track_duplicate", v.obj({"track": lom.TRACK_ONLY_REF}, required=["track"]),
                _track_duplicate, mutating=True, precheck=_duplicate_check,
                edition_delta=lambda args: {"tracks": 1}))
    reg(Command("track_set", v.obj({
        "track": ref, "name": lom.NAME, "color": lom.COLOR, "mute": v.boolean(), "solo": v.boolean(),
        "arm": v.boolean(), "fold_state": v.boolean(), "monitoring_state": v.integer(min=0, max=2),
    }, required=["track"]), _track_set, mutating=True, precheck=_set_check))
    reg(Command("track_select", v.obj({"track": ref}, required=["track"]), _track_select,
                mutating=True, precheck=_resolve_only))
    reg(Command("track_stop_clips", v.obj({"track": lom.TRACK_ONLY_REF}, required=["track"]),
                _track_stop_clips, mutating=True, precheck=_resolve_only))
    reg(Command("meters_get", v.obj({"tracks": v.array(ref, min_items=1, max_items=32),
                                     "all": v.boolean()}, exclusive=[("tracks", "all")]),
                _meters_get, prepare=_meters_prepare))
