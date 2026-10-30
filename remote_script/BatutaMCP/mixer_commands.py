"""Mixer and routing commands (docs/01-protocol.md section 7.3).

The gain guard of section 9.4 lives in the TypeScript server; here `mixer_set` only declares the
`volume`/`volume_db` conditions in the catalog so the server's stricter classification can be
cross-checked. Values are never clamped: out-of-range input is an `out_of_range` error found
before the undo step opens.
"""

from . import lom
from . import validator as v
from .errors import BatutaError
from .registry import Command

DB_MIN = -70
DB_MAX = 6
MAX_SENDS = 12

SEND_ITEM = v.obj({"index": v.integer(min=0), "value": v.number()}, required=["index", "value"])


# ----------------------------------------------------------------- mixer_get

def _send_json(song, position, param):
    returns = song.return_tracks
    name = lom.text(returns[position].name) if position < len(returns) else lom.text(param.name)
    result = lom.param_json(param)
    result.update({"index": position, "name": name})
    return result


def mixer_json(song, kind, track):
    mixer = track.mixer_device
    master = kind == "master"
    return {
        "volume": lom.volume_json(mixer.volume),
        "pan": lom.param_json(mixer.panning),
        "sends": [_send_json(song, position, param) for position, param in enumerate(mixer.sends)],
        "track_activator": lom.safe(lambda: bool(mixer.track_activator.value >= 0.5)),
        "crossfade_assign": lom.as_int(lom.safe(lambda: mixer.crossfade_assign)) if not master else None,
        "cue_volume": lom.param_json(mixer.cue_volume) if master else None,
        "crossfader": lom.param_json(mixer.crossfader) if master else None,
    }


def _mixer_get(ctx, args):
    ref = args["track"]
    track = lom.resolve_track(ctx.song, ref)
    return mixer_json(ctx.song, ref["kind"], track)


# ----------------------------------------------------------------- mixer_set

def _plan(ctx, args):
    """Validate every field and return the writes [(label, param_or_name, value)]; no LOM writes."""
    ref = args["track"]
    kind = ref["kind"]
    track = lom.resolve_track(ctx.song, ref)
    mixer = track.mixer_device
    if not any(field in args for field in ("volume", "volume_db", "pan", "sends", "crossfade_assign",
                                           "cue_volume", "crossfader")):
        raise lom.invalid("at_least_one", "give at least one field to change")
    master = kind == "master"
    if "crossfade_assign" in args and master:
        raise lom.invalid("master_field", "the master track has no crossfade assignment")
    for field in ("cue_volume", "crossfader"):
        if field in args and not master:
            raise lom.invalid("master_only", "%s exists on the master track only" % field)
    plan = []
    if "volume" in args:
        plan.append((mixer.volume, lom.checked_value("volume", mixer.volume, args["volume"])))
    if "volume_db" in args:
        target = args["volume_db"]
        if not DB_MIN <= target <= DB_MAX:
            raise lom.out_of_range("volume_db", DB_MIN, DB_MAX, target)
        plan.append((mixer.volume, lom.raw_for_db(mixer.volume, target)))
    if "pan" in args:
        plan.append((mixer.panning, lom.checked_value("pan", mixer.panning, args["pan"])))
    if "sends" in args:
        seen = set()
        sends = list(mixer.sends)
        for item in args["sends"]:
            index = item["index"]
            if index in seen:
                raise lom.invalid("duplicate_send", "a send index appears twice", index=index)
            seen.add(index)
            if index >= len(sends):
                raise lom.not_found("send", index)
            plan.append((sends[index], lom.checked_value("send", sends[index], item["value"])))
    if "cue_volume" in args:
        plan.append((mixer.cue_volume, lom.checked_value("cue_volume", mixer.cue_volume, args["cue_volume"])))
    if "crossfader" in args:
        plan.append((mixer.crossfader, lom.checked_value("crossfader", mixer.crossfader, args["crossfader"])))
    return track, mixer, plan


def _mixer_set(ctx, args):
    track, mixer, plan = _plan(ctx, args)
    ctx.note_mutation()
    for param, value in plan:
        param.value = value
    if "crossfade_assign" in args:
        mixer.crossfade_assign = args["crossfade_assign"]
    return {"mixer": mixer_json(ctx.song, args["track"]["kind"], track)}


# ----------------------------------------------------------------- routing

def _options(items):
    return [lom.text(lom.safe(lambda: item.display_name)) for item in list(items)[:lom.MAX_LISTED_OPTIONS]]


def _side_json(kind_type, kind_channel, available_types, available_channels):
    return {"type": lom.text(kind_type.display_name), "channel": lom.text(kind_channel.display_name),
            "available_types": _options(available_types),
            "available_channels": _options(available_channels)}


def routing_json(kind, track):
    """Input is null for return and master tracks (they have no input routing)."""
    source = None
    if kind == "track":
        source = lom.safe(lambda: _side_json(track.input_routing_type, track.input_routing_channel,
                                             track.available_input_routing_types,
                                             track.available_input_routing_channels))
    target = _side_json(track.output_routing_type, track.output_routing_channel,
                        track.available_output_routing_types, track.available_output_routing_channels)
    return {"input": source, "output": target}


def _routing_get(ctx, args):
    ref = args["track"]
    return routing_json(ref["kind"], lom.resolve_track(ctx.song, ref))


def _routing_check(ctx, args):
    """Validate type names now; channel names are matched after the type is applied (they depend on it)."""
    ref = args["track"]
    kind = ref["kind"]
    track = lom.resolve_track(ctx.song, ref)
    if not any(field in args for field in ("input_type", "input_channel", "output_type", "output_channel")):
        raise lom.invalid("at_least_one", "give at least one routing field")
    if kind != "track" and ("input_type" in args or "input_channel" in args):
        raise lom.invalid("no_input_routing", "only regular tracks have input routing")
    safety = ctx.recording
    if "input_type" in args:
        chosen = safety.resolve_routing_type(list(track.available_input_routing_types), args["input_type"])
        safety.check_routing_result(track, chosen)  # rule 3
    elif "input_channel" in args:
        safety.resolve_routing_type(list(track.available_input_routing_channels), args["input_channel"],
                                    "routing_channel")
    if "output_type" in args:
        safety.resolve_routing_type(list(track.available_output_routing_types), args["output_type"])
    elif "output_channel" in args:
        safety.resolve_routing_type(list(track.available_output_routing_channels), args["output_channel"],
                                    "routing_channel")
    return track


def _channel_after_type(ctx, available, name):
    """A channel lookup after a write already happened: a failure is reported as partial."""
    try:
        return ctx.recording.resolve_routing_type(available, name, "routing_channel")
    except BatutaError as exc:
        exc.details = dict(exc.details or {}, partial=True)
        raise


def _routing_set(ctx, args):
    track = _routing_check(ctx, args)
    safety = ctx.recording
    ctx.note_mutation()
    if "input_type" in args:
        track.input_routing_type = safety.resolve_routing_type(
            list(track.available_input_routing_types), args["input_type"])
    if "input_channel" in args:
        track.input_routing_channel = _channel_after_type(
            ctx, list(track.available_input_routing_channels), args["input_channel"])
    if "output_type" in args:
        track.output_routing_type = safety.resolve_routing_type(
            list(track.available_output_routing_types), args["output_type"])
    if "output_channel" in args:
        track.output_routing_channel = _channel_after_type(
            ctx, list(track.available_output_routing_channels), args["output_channel"])
    return {"routing": routing_json(args["track"]["kind"], track)}


def install(registry):
    reg = registry.register
    ref = v.TRACK_REF
    reg(Command("mixer_get", v.obj({"track": ref}, required=["track"]), _mixer_get))
    reg(Command("mixer_set", v.obj({
        "track": ref, "volume": v.number(), "volume_db": v.number(), "pan": v.number(),
        "sends": v.array(SEND_ITEM, min_items=1, max_items=MAX_SENDS),
        "crossfade_assign": v.integer(min=0, max=2), "cue_volume": v.number(), "crossfader": v.number(),
    }, required=["track"], exclusive=[("volume", "volume_db")]), _mixer_set, mutating=True,
        destructive="conditional", conditions=("volume", "volume_db"), precheck=_plan))
    reg(Command("routing_get", v.obj({"track": ref}, required=["track"]), _routing_get))
    name = v.string(max_chars=128)
    reg(Command("routing_set", v.obj({
        "track": ref, "input_type": name, "input_channel": name,
        "output_type": name, "output_channel": name,
    }, required=["track"]), _routing_set, mutating=True, precheck=_routing_check))
