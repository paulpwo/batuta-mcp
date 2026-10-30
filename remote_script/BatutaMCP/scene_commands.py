"""Scene and cue point commands (docs/01-protocol.md sections 7.4 and 7.5).

Cue edits move the playhead to toggle a cue (`set_or_delete_cue` works at the current position,
assumption A16). Live applies a playhead write on its next tick, so seek, toggle, inspect and restore
run on separate ticks (a resumable handler, see dispatcher.NEXT_TICK). The playhead is restored on
every exit path, including a Live error or a dropped connection.
"""

from . import lom
from . import validator as v
from .dispatcher import NEXT_TICK
from .errors import BatutaError
from .registry import Command

SIGNATURE_DENOMINATORS = (1, 2, 4, 8, 16)
TEMPO = v.number(min=20, max=999)
SCENE_INDEX = v.integer(min=0)


# ----------------------------------------------------------------- scenes: reads and create

def _scene_list(ctx, args):
    return lom.page(ctx.song.scenes, args, lom.scene_info)


def _apply_scene_tempo(scene, tempo):
    if tempo is None:
        scene.tempo_enabled = False
        return
    scene.tempo = tempo
    if hasattr(scene, "tempo_enabled"):
        scene.tempo_enabled = True


def _create_check(ctx, args):
    count = len(ctx.song.scenes)
    if args["index"] > count:
        raise lom.out_of_range("index", -1, count, args["index"])
    ctx.edition.check("scenes", count)


def _scene_create(ctx, args):
    _create_check(ctx, args)
    song = ctx.song
    index = args["index"]
    ctx.note_mutation()
    song.create_scene(index)
    position = len(song.scenes) - 1 if index < 0 else index
    scene = song.scenes[position]
    if "name" in args:
        scene.name = args["name"]
    if "color" in args:
        scene.color = args["color"]
    if "tempo" in args:
        _apply_scene_tempo(scene, args["tempo"])
    return {"scene": lom.scene_info(position, scene)}


def _capacity_check(ctx, args):
    lom.resolve_scene(ctx.song, args["scene"]) if "scene" in args else None
    ctx.edition.check("scenes", len(ctx.song.scenes))


def _scene_duplicate(ctx, args):
    _capacity_check(ctx, args)
    song = ctx.song
    index = args["scene"]
    ctx.note_mutation()
    song.duplicate_scene(index)
    return {"scene": lom.scene_info(index + 1, song.scenes[index + 1])}


def _scene_capture(ctx, args):
    _capacity_check(ctx, args)
    song = ctx.song
    before = list(song.scenes)
    ctx.note_mutation()
    song.capture_and_insert_scene()
    after = list(song.scenes)
    created = lom.new_items(before, after)
    if not created:
        raise BatutaError("lom_error", "capture_and_insert_scene created no scene",
                          {"exception": "NoNewScene", "partial": True})
    return {"scene": lom.scene_info(lom.position_of(after, created[0]), created[0])}


# ----------------------------------------------------------------- scenes: delete, set, fire

def _delete_check(ctx, args):
    return lom.resolve_scene(ctx.song, args["scene"], args.get("expect_name"))


def _scene_delete(ctx, args):
    scene = _delete_check(ctx, args)
    deleted = {"index": args["scene"], "name": lom.text(lom.safe(lambda: scene.name))}
    ctx.note_mutation()
    ctx.song.delete_scene(args["scene"])
    return {"deleted": deleted}


def _set_prepare(args, registry):
    shown = args.get("time_signature")
    if shown is not None:
        numerator, denominator = shown
        if not 1 <= numerator <= 99 or denominator not in SIGNATURE_DENOMINATORS:
            raise lom.invalid("time_signature", "time_signature must be [1..99, 1|2|4|8|16]")
    return args


def _set_check(ctx, args):
    scene = lom.resolve_scene(ctx.song, args["scene"])
    if not any(field in args for field in ("name", "color", "tempo", "time_signature")):
        raise lom.invalid("at_least_one", "give at least one field to change")
    if "tempo" in args and args["tempo"] is None and not hasattr(scene, "tempo_enabled"):
        raise BatutaError("not_supported", "this Live version cannot disable a scene tempo",
                          {"reason": "live_version"})
    if "time_signature" in args and args["time_signature"] is None \
            and not hasattr(scene, "time_signature_enabled"):  # assumption A29
        raise BatutaError("not_supported", "this Live version cannot disable a scene time signature",
                          {"reason": "live_version"})
    return scene


def _scene_set(ctx, args):
    scene = _set_check(ctx, args)
    ctx.note_mutation()
    if "name" in args:
        scene.name = args["name"]
    if "color" in args:
        scene.color = args["color"]
    if "tempo" in args:
        _apply_scene_tempo(scene, args["tempo"])
    if "time_signature" in args:
        shown = args["time_signature"]
        if shown is None:
            scene.time_signature_enabled = False
        else:
            scene.time_signature_numerator = shown[0]
            scene.time_signature_denominator = shown[1]
            if hasattr(scene, "time_signature_enabled"):
                scene.time_signature_enabled = True
    return {"scene": lom.scene_info(args["scene"], scene)}


def _would_record(song, index):
    """True when firing scene `index` would start recording into an empty slot of an armed track."""
    for track in song.tracks:
        slots = lom.safe(lambda: list(track.clip_slots), [])
        if lom.is_armed(track) and index < len(slots) and not lom.safe(lambda: slots[index].has_clip, False):
            return True
    return False


def _fire_check(ctx, args):
    scene = lom.resolve_scene(ctx.song, args["scene"])
    ctx.recording.check_playback_while_recording(ctx.song)  # rule 4 tail
    if _would_record(ctx.song, args["scene"]):
        ctx.recording.check_record_start("scene_fire")  # rule 4: fires an empty slot on an armed track
    return scene


def _scene_fire(ctx, args):
    scene = _fire_check(ctx, args)
    ctx.note_mutation()
    if args["as_selected"]:
        scene.fire_as_selected(args["force_legato"])
    else:
        scene.fire(args["force_legato"], args["can_select_scene_on_launch"])
    return {}


# ----------------------------------------------------------------- cue points

def _cue_json(index, cue):
    return {"index": index, "name": lom.text(lom.safe(lambda: cue.name)), "time": float(cue.time)}


def _cue_list(ctx, args):
    return lom.page(list(ctx.song.cue_points), args, _cue_json)


def _require_stopped(song):
    if song.is_playing:
        raise lom.invalid("transport_running", "stop the transport before editing cue points")


def _cue_create_check(ctx, args):
    song = ctx.song
    _require_stopped(song)
    cues = list(song.cue_points)
    for cue in cues:
        if abs(float(cue.time) - args["time"]) <= lom.CUE_TOLERANCE:
            raise lom.invalid("cue_exists", "a cue point already exists at this time",
                              time=float(cue.time))
    close = lom.nearby_cue(cues, args["time"])
    if close is not None:  # Live would toggle that cue off instead of creating a new one
        raise lom.invalid("cue_nearby", "another cue point is too close to this time", nearby_cue=close)


class _undo_step:
    """`with` block that spans ticks: one undo step for everything that changes cues."""

    def __init__(self, song):
        self._song = song

    def __enter__(self):
        self._song.begin_undo_step()

    def __exit__(self, *exc_info):
        self._song.end_undo_step()


def _cue_snapshot(cues):
    """[(cue, {name, time})] read while the cues are alive: a removed cue can no longer be read."""
    return [(cue, {"name": lom.text(lom.safe(lambda: cue.name)),
                   "time": lom.safe(lambda: float(cue.time))}) for cue in cues]


def _snapshot_of(snapshot, cue):
    for known, shown in snapshot:
        if lom.same(known, cue):
            return shown
    return {"name": "", "time": None}


def _seek(song, time):
    """Move the playhead to `time` and wait one tick; fail if Live did not take it (nothing toggled)."""
    song.current_song_time = time
    yield NEXT_TICK
    reached = lom.safe(lambda: float(song.current_song_time))
    if reached is None or abs(reached - time) > lom.CUE_TOLERANCE:
        raise BatutaError("lom_error", "the playhead did not reach the requested time; "
                          "no cue point was changed",
                          {"exception": "PlayheadNotReached", "partial": False,
                           "requested": time, "reached": reached})


def _toggle_cue_at(song, time):
    """Seek (tick 1), verify, toggle (same tick as the verify); the caller inspects on the next tick."""
    yield from _seek(song, time)
    song.set_or_delete_cue()
    yield NEXT_TICK


def _restore_playhead(ctx, playhead):
    try:
        ctx.song.current_song_time = playhead
    except Exception as exc:  # never mask the command's own outcome
        ctx.log("playhead restore failed: %s" % type(exc).__name__)


def _with_playhead_restored(ctx, steps):
    """Run `steps` (a generator), then restore the playhead on a later tick and wait for it to land.

    The restore also runs when the handler is closed early (timeout or lost client)."""
    playhead = float(ctx.song.current_song_time)
    failure = None
    result = None
    try:
        result = yield from steps
    except Exception as exc:
        failure = exc
    finally:
        _restore_playhead(ctx, playhead)
    yield NEXT_TICK  # the next command must not read the old playhead
    if failure is not None:
        raise failure
    return result


def _needs_ticks(ctx, name):
    if not lom.runs_top_level(ctx, name):
        raise BatutaError("not_supported", "cue point edits wait for Live's ticks and cannot run "
                          "inside batch", {"reason": "needs_ticks"})


def _cue_create_steps(ctx, args):
    _cue_create_check(ctx, args)
    song = ctx.song
    time = args["time"]
    before = list(song.cue_points)
    snapshot = _cue_snapshot(before)
    ctx.note_mutation()
    yield from _seek(song, time)
    with _undo_step(song):
        song.set_or_delete_cue()
        yield NEXT_TICK  # the cue list may lag behind the toggle too
        after = list(song.cue_points)
        created = lom.new_items(before, after)
        gone = lom.new_items(after, before)
        if gone:  # Live toggles within its own tolerance: a nearby cue was removed instead
            raise BatutaError("lom_error", "a nearby cue point was removed instead of a new one created",
                              {"exception": "CueToggledOff", "partial": True,
                               "deleted_cue": _snapshot_of(snapshot, gone[0])})
        if not created:
            raise BatutaError("lom_error", "set_or_delete_cue created no cue point",
                              {"exception": "NoNewCue", "partial": True})
        cue = created[0]
        cue_time = lom.safe(lambda: float(cue.time))
        if cue_time is None or abs(cue_time - time) > lom.CUE_TOLERANCE:
            yield from _undo_wrong_cue(song, before, cue_time)
        if "name" in args:
            cue.name = args["name"]
    return {"cue": _cue_json(lom.position_of(list(song.cue_points), cue), cue)}


def _undo_wrong_cue(song, before, wrong_time):
    """A cue appeared at the wrong time: toggle it off again (own ticks) and report the error."""
    removed = False
    if wrong_time is not None:
        try:
            yield from _toggle_cue_at(song, wrong_time)
            removed = not lom.new_items(before, list(song.cue_points))
        except BatutaError:
            removed = False
    details = {"exception": "WrongCueTime", "partial": not removed, "created_at": wrong_time}
    message = "Live created the cue point at the wrong time"
    raise BatutaError("lom_error", message + (", so it was removed again" if removed else ""), details)


def _cue_create(ctx, args):
    _cue_create_check(ctx, args)  # a batch op is refused on its own merits first
    _needs_ticks(ctx, "cue_create")
    return _with_playhead_restored(ctx, _cue_create_steps(ctx, args))


def _resolve_cue(song, index):
    cues = list(song.cue_points)
    if index >= len(cues):
        raise lom.not_found("cue", index)
    return cues[index]


def _cue_delete_check(ctx, args):
    song = ctx.song
    _require_stopped(song)
    cue = _resolve_cue(song, args["index"])
    expected = args.get("expect_time")
    if expected is not None and abs(float(cue.time) - expected) > lom.CUE_TOLERANCE:
        raise lom.not_found("cue", args["index"], "time_mismatch")
    close = lom.nearby_cue(list(song.cue_points), float(cue.time), skip=cue)
    if close is not None:  # the toggle could remove the neighbour instead of this cue
        raise lom.invalid("cue_nearby", "another cue point is too close to this one", nearby_cue=close)
    return cue


def _removed_positions(before, after):
    """Positions in `before` of the cues missing from `after`.

    Only surviving cues are matched: Live's wrapper of a deleted cue equals nothing, not even another
    wrapper of the same cue, so the removed cue is identified by its position (owner's Lite run)."""
    matched = set()
    for item in after:
        for position, known in enumerate(before):
            if position not in matched and lom.same(known, item):
                matched.add(position)
                break
    return [position for position in range(len(before)) if position not in matched]


def _cue_delete_steps(ctx, args):
    cue = _cue_delete_check(ctx, args)
    song = ctx.song
    before = list(song.cue_points)
    snapshot = _cue_snapshot(before)
    deleted = dict(_snapshot_of(snapshot, cue), index=args["index"])
    ctx.note_mutation()
    yield from _seek(song, deleted["time"])
    with _undo_step(song):
        song.set_or_delete_cue()
        yield NEXT_TICK
        removed = _removed_positions(before, list(song.cue_points))
        if removed != [args["index"]]:  # never report success for the wrong cue
            details = {"exception": "WrongCueRemoved", "partial": True}
            if removed:
                details["deleted_cue"] = snapshot[removed[0]][1]
            raise BatutaError("lom_error", "set_or_delete_cue did not remove the requested cue point",
                              details)
    return {"deleted": deleted}


def _cue_delete(ctx, args):
    _cue_delete_check(ctx, args)
    _needs_ticks(ctx, "cue_delete")
    return _with_playhead_restored(ctx, _cue_delete_steps(ctx, args))


def _cue_set_check(ctx, args):
    return _resolve_cue(ctx.song, args["index"])


def _cue_set(ctx, args):
    cue = _cue_set_check(ctx, args)
    ctx.note_mutation()
    cue.name = args["name"]
    return {"cue": _cue_json(args["index"], cue)}


def _cue_jump_prepare(args, registry):
    if ("index" in args) == ("direction" in args):
        raise lom.invalid("selector", "give either index or direction")
    return args


def _cue_jump_check(ctx, args):
    if "index" in args:
        return _resolve_cue(ctx.song, args["index"])
    return None


def _cue_jump_write(song, cue, args):
    if cue is not None:
        cue.jump()
    elif args["direction"] == "next":
        song.jump_to_next_cue()
    else:
        song.jump_to_prev_cue()


def _cue_jump_deferred(ctx, args, cue):
    """Jump, then answer on Live's next tick: the playhead only moves after the call is processed."""
    song = ctx.song
    ctx.note_mutation()
    song.begin_undo_step()
    try:
        _cue_jump_write(song, cue, args)
    finally:
        song.end_undo_step()
    yield NEXT_TICK
    return {"current_song_time": float(song.current_song_time)}


def _cue_jump(ctx, args):
    cue = _cue_jump_check(ctx, args)
    if lom.runs_top_level(ctx, "cue_jump"):
        return _cue_jump_deferred(ctx, args, cue)
    # Inside `batch` there is no tick to wait for: the reply shows the playhead before the jump landed.
    ctx.note_mutation()
    _cue_jump_write(ctx.song, cue, args)
    return {"current_song_time": float(ctx.song.current_song_time)}


def install(registry):
    reg = registry.register
    reg(Command("scene_list", v.obj(dict(v.PAGING_PROPS)), _scene_list))
    reg(Command("scene_create", v.obj({
        "index": v.with_default(v.integer(min=-1), -1), "name": lom.NAME, "color": lom.COLOR,
        "tempo": TEMPO}), _scene_create, mutating=True, precheck=_create_check,
        edition_delta=lambda args: {"scenes": 1}))
    reg(Command("scene_delete", v.obj({"scene": SCENE_INDEX, "expect_name": lom.NAME},
                                      required=["scene"]), _scene_delete, mutating=True,
                destructive="always", precheck=_delete_check,
                edition_delta=lambda args: {"scenes": -1}))
    reg(Command("scene_duplicate", v.obj({"scene": SCENE_INDEX}, required=["scene"]),
                _scene_duplicate, mutating=True, precheck=_capacity_check,
                edition_delta=lambda args: {"scenes": 1}))
    reg(Command("scene_set", v.obj({
        "scene": SCENE_INDEX, "name": lom.NAME, "color": lom.COLOR, "tempo": v.nullable(TEMPO),
        "time_signature": v.nullable(v.array(v.integer(), min_items=2, max_items=2)),
    }, required=["scene"]), _scene_set, mutating=True, prepare=_set_prepare, precheck=_set_check))
    reg(Command("scene_fire", v.obj({
        "scene": SCENE_INDEX, "force_legato": v.with_default(v.boolean(), False),
        "can_select_scene_on_launch": v.with_default(v.boolean(), True),
        "as_selected": v.with_default(v.boolean(), False)}, required=["scene"]),
        _scene_fire, mutating=True, precheck=_fire_check))
    reg(Command("scene_capture", v.obj({}), _scene_capture, mutating=True, precheck=_capacity_check,
                edition_delta=lambda args: {"scenes": 1}))
    reg(Command("cue_list", v.obj(dict(v.PAGING_PROPS)), _cue_list))
    reg(Command("cue_create", v.obj({"time": v.number(min=0), "name": lom.NAME}, required=["time"]),
                _cue_create, mutating=True, undo_wrapped=False, precheck=_cue_create_check))
    reg(Command("cue_delete", v.obj({"index": v.integer(min=0), "expect_time": v.number()},
                                    required=["index"]), _cue_delete, mutating=True,
                undo_wrapped=False, destructive="always", precheck=_cue_delete_check))
    reg(Command("cue_set", v.obj({"index": v.integer(min=0), "name": lom.NAME},
                                 required=["index", "name"]), _cue_set, mutating=True,
                precheck=_cue_set_check))
    reg(Command("cue_jump", v.obj({"index": v.integer(min=0), "direction": v.enum("next", "prev")},
                                  exclusive=[("index", "direction")]), _cue_jump, mutating=True,
                undo_wrapped=False, prepare=_cue_jump_prepare, precheck=_cue_jump_check))
