"""Arrangement clip commands (docs/01-protocol.md section 7.11).

Overlap rule: a new arrangement clip may not intersect existing clips on its track unless the call
says `allow_overwrite` (Live replaces the covered region, assumption A15). Clips that only touch do
not overlap. Each mutating command has a `check` that is the precheck and is called again by the
handler, so the same refusals hold per op inside `batch`.

Live leaves the playhead at the destination of a copy. Like cue edits, the copy commands put it back:
at top level on a later tick (waiting for Live to take it), inside `batch` at once without waiting.
While the transport plays the playhead moves on its own, so it is left alone.
"""

from . import clip_lom
from . import lom
from . import validator as v
from .errors import BatutaError, from_exception
from .registry import Command
from .scene_commands import _undo_step, _with_playhead_restored


def _no_new_clip(command):
    return BatutaError("lom_error", "%s created no arrangement clip" % command,
                       {"exception": "NoNewClip", "partial": True})


# ----------------------------------------------------------------- arrangement_clips

def _clip_row(index, clip):
    start, end = clip_lom.clip_span(clip)
    return {"index": index, "name": lom.text(lom.safe(lambda: clip.name)), "start_time": start,
            "end_time": end, "length": end - start,
            "loop_length": lom.as_float(lom.safe(lambda: clip.length)), "is_midi": clip_lom.is_midi_clip(clip),
            "is_audio": clip_lom.is_audio_clip(clip)}


def _arrangement_clips(ctx, args):
    track = lom.resolve_track(ctx.song, args["track"])
    low, high = args.get("from"), args.get("to")
    if low is not None and high is not None and not low < high:
        raise lom.invalid("range", "from must be smaller than to", **{"from": low, "to": high})
    entries = []
    for index, clip in enumerate(clip_lom.arrangement_clips(track)):
        start, end = clip_lom.clip_span(clip)
        if (low is not None and end <= low) or (high is not None and start >= high):
            continue
        entries.append((index, clip))
    return lom.page(entries, args, lambda _, entry: _clip_row(entry[0], entry[1]))


# ----------------------------------------------------------------- arrangement_clip_create

def _create_check(ctx, args):
    track = lom.resolve_track(ctx.song, args["track"])
    if not clip_lom.is_midi_track(track):
        raise lom.invalid("not_midi_track", "arrangement_clip_create needs a MIDI track")
    found = clip_lom.overlapping(clip_lom.arrangement_clips(track), args["start"],
                                 args["start"] + args["length"])
    if found:
        raise clip_lom.overlap_error(found)
    return track


def _arrangement_clip_create(ctx, args):
    track = _create_check(ctx, args)
    shown = lom.normal_ref(args["track"])
    before = clip_lom.arrangement_clips(track)
    ctx.note_mutation()
    track.create_midi_clip(args["start"], args["length"])
    created = clip_lom.find_created(track, before, args["start"])
    if created is None:
        raise _no_new_clip("create_midi_clip")
    if "name" in args:
        created.name = args["name"]
    target = clip_lom.arrangement_target(track, shown, created)
    if target is None:
        raise _no_new_clip("create_midi_clip")
    return {"clip": clip_lom.clip_info(target)}


# ----------------------------------------------------------------- arrangement_duplicate

def _fits_track(clip, track):
    if clip_lom.is_midi_clip(clip):
        return clip_lom.is_midi_track(track)
    return clip_lom.is_audio_clip(clip) and clip_lom.is_audio_track(track)


def _duplicate_check(ctx, args):
    source = clip_lom.resolve_clip(ctx.song, args["source"])
    track = lom.resolve_track(ctx.song, args["track"])
    clip = source.clip
    if not _fits_track(clip, track):
        raise lom.invalid("incompatible_track", "the target track cannot hold this kind of clip")
    if not args["allow_overwrite"]:
        found = clip_lom.overlapping(clip_lom.arrangement_clips(track), args["time"],
                                     args["time"] + clip_lom.new_clip_extent(clip))
        if found:
            raise clip_lom.overlap_error(found)
    return source, track


def _duplicate_into(track, shown, clip, time):
    """Duplicate `clip` onto the arrangement of `track`; ClipTarget of the new clip."""
    before = clip_lom.arrangement_clips(track)
    returned = track.duplicate_clip_to_arrangement(clip, time)
    created = clip_lom.find_created(track, before, time)
    if created is None:
        created = returned
    target = clip_lom.arrangement_target(track, shown, created) if created is not None else None
    if target is None:
        raise _no_new_clip("duplicate_clip_to_arrangement")
    return target


def _playing(song):
    return lom.safe(lambda: song.is_playing) is True


def _restoring_playhead(ctx, name, steps, write):
    """Run a copy and put the playhead back. -> a generator at top level, else the result of `write()`."""
    if lom.runs_top_level(ctx, name):
        return steps() if _playing(ctx.song) else _with_playhead_restored(ctx, steps())
    playhead = lom.safe(lambda: float(ctx.song.current_song_time))
    try:
        return write()
    finally:
        if playhead is not None and not _playing(ctx.song):
            try:
                ctx.song.current_song_time = playhead
            except Exception as exc:  # never mask the command's own outcome
                ctx.log("playhead restore failed: %s" % type(exc).__name__)


def _arrangement_duplicate(ctx, args):
    source, track = _duplicate_check(ctx, args)

    def write():
        ctx.note_mutation()
        target = _duplicate_into(track, lom.normal_ref(args["track"]), source.clip, args["time"])
        return {"clip": clip_lom.clip_info(target)}

    def steps():
        with _undo_step(ctx.song):
            return write()
        yield  # a generator, so the pump can wait for Live between the copy and the restore

    return _restoring_playhead(ctx, "arrangement_duplicate", steps, write)


# ----------------------------------------------------------------- arrangement_commit_scene

def _commit_entries(song, args):
    if "tracks" not in args:
        return [({"kind": "track", "index": index}, track) for index, track in enumerate(song.tracks)]
    entries = []
    for ref in args["tracks"]:
        track = lom.resolve_track(song, ref)
        if any(lom.same(track, known) for _, known in entries):
            raise lom.invalid("duplicate_track", "tracks names the same track twice", index=ref["index"])
        entries.append((ref, track))
    return entries


def _commit_check(ctx, args):
    """Validate every target before anything is written: (plan, skipped)."""
    song = ctx.song
    scene = args["scene"]
    lom.resolve_scene(song, scene)
    plan, skipped, conflicts = [], [], []
    for ref, track in _commit_entries(song, args):
        shown = lom.normal_ref(ref)
        slots = clip_lom.session_slots(track)
        if scene >= len(slots) or not clip_lom.has_clip(slots[scene]):
            skipped.append(shown)
            continue
        clip = slots[scene].clip
        if not args["allow_overwrite"]:
            found = clip_lom.overlapping(clip_lom.arrangement_clips(track), args["time"],
                                         args["time"] + clip_lom.new_clip_extent(clip))
            if found:
                conflicts.append({"track": shown, "clips": found[:clip_lom.MAX_OVERLAP_DETAILS]})
        plan.append((track, shown, clip))
    if conflicts:
        raise clip_lom.overlap_error([], conflicts=conflicts[:clip_lom.MAX_OVERLAP_DETAILS],
                                     conflict_count=len(conflicts))
    if not plan:
        raise lom.invalid("no_clips", "the scene has no clips on the selected tracks")
    return plan, skipped


def _arrangement_commit_scene(ctx, args):
    plan, skipped = _commit_check(ctx, args)

    def write():
        ctx.note_mutation()
        clips, done = [], []
        try:
            for track, shown, clip in plan:
                clips.append(clip_lom.clip_info(_duplicate_into(track, shown, clip, args["time"])))
                done.append(shown)
        except Exception as exc:  # name the tracks already written, so the client can undo or finish
            error = from_exception(exc, partial=True)
            error.details = dict(error.details or {}, done=done)
            raise error
        return {"clips": clips, "skipped": skipped}

    def steps():
        with _undo_step(ctx.song):
            return write()
        yield

    return _restoring_playhead(ctx, "arrangement_commit_scene", steps, write)


# ----------------------------------------------------------------- registration

def install(registry):
    reg = registry.register
    track = lom.TRACK_ONLY_REF
    reg(Command("arrangement_clips", v.obj(dict({
        "track": track, "from": v.number(min=0), "to": v.number(min=0)}, **v.PAGING_PROPS),
        required=["track"]), _arrangement_clips))
    reg(Command("arrangement_clip_create", v.obj({
        "track": track, "start": v.number(min=0), "length": v.number(min=0.25, max=4096),
        "name": lom.NAME}, required=["track", "start", "length"]), _arrangement_clip_create,
        mutating=True, precheck=_create_check))
    reg(Command("arrangement_duplicate", v.obj({
        "source": clip_lom.CLIP_REF, "track": track, "time": v.number(min=0),
        "allow_overwrite": v.with_default(v.boolean(), False)}, required=["source", "track", "time"]),
        _arrangement_duplicate, mutating=True, undo_wrapped=False, destructive="conditional",
        conditions=("allow_overwrite",), precheck=_duplicate_check))
    reg(Command("arrangement_commit_scene", v.obj({
        "scene": v.integer(min=0), "time": v.number(min=0),
        "tracks": v.array(track, min_items=1), "allow_overwrite": v.with_default(v.boolean(), False)},
        required=["scene", "time"]), _arrangement_commit_scene, mutating=True, undo_wrapped=False,
        destructive="conditional", conditions=("allow_overwrite",), precheck=_commit_check))
