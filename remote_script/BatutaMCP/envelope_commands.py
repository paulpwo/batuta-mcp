"""Session clip envelope commands (docs/01-protocol.md section 7.7).

Only session clips carry writable envelopes (assumption in docs/00-research.md); an arrangement
ClipRef is `not_supported` with reason `arrangement`. A parameter must belong to the clip's own
track, so a ParamRef that names another track's volume or device is refused before Live sees it.
Each mutating command has a `check` that is the precheck and is called again by the handler.
"""

from . import clip_lom
from . import device_path
from . import lom
from . import validator as v
from .errors import BatutaError
from .registry import Command

ENVELOPE_SCAN_CAP = 1000  # device parameters inspected by envelope_list (Appendix A)
TIME_TOLERANCE = 1e-6


def _arrangement_unsupported():
    return BatutaError("not_supported", "clip envelopes are only available on session clips",
                       {"reason": "arrangement"})


def _session_clip(ctx, args):
    if args["clip"]["kind"] == "arrangement":
        raise _arrangement_unsupported()
    return clip_lom.resolve_clip(ctx.song, args["clip"])


def _param_of(ctx, target, args):
    track, param = device_path.resolve_param(ctx.song, args["param"])
    if not lom.same(track, target.track):
        raise lom.invalid("param_track_mismatch", "the parameter belongs to another track than the clip")
    return param


# ----------------------------------------------------------------- envelope_list / envelope_get

def _mixer_candidates(track, shown):
    mixer = track.mixer_device
    found = [({"mixer": "volume", "track": shown}, mixer.volume),
             ({"mixer": "pan", "track": shown}, mixer.panning)]
    for index, send in enumerate(lom.safe(lambda: list(mixer.sends), [])):
        found.append(({"mixer": "send", "track": shown, "index": index}, send))
    return found


def _envelope_list(ctx, args):
    target = _session_clip(ctx, args)
    clip, shown = target.clip, target.track_ref
    candidates = _mixer_candidates(target.track, shown)
    scanned = 0
    truncated = False
    for path, device in device_path.walk_devices(target.track):
        for index, param in enumerate(lom.safe(lambda: list(device.parameters), [])):
            if scanned >= ENVELOPE_SCAN_CAP:
                truncated = True
                break
            scanned += 1
            candidates.append((device_path.param_ref_json(shown, path, index, None), param))
        if truncated:
            break
    envelopes = []
    for ref, param in candidates:
        if lom.safe(lambda: clip.automation_envelope(param)) is None:
            continue
        ref = dict(ref, name=lom.text(lom.safe(lambda: param.name)))
        envelopes.append(ref)
    return {"envelopes": envelopes, "scanned": scanned, "truncated": truncated}


def _get_check(ctx, args):
    target = _session_clip(ctx, args)
    param = _param_of(ctx, target, args)
    start = args["from"]
    end = args["to"] if "to" in args else float(target.clip.length)
    if not start < end:
        raise lom.invalid("range", "from must be smaller than to", **{"from": start, "to": end})
    return target, param, start, end


def _envelope_get(ctx, args):
    target, param, start, end = _get_check(ctx, args)
    envelope = target.clip.automation_envelope(param)
    if envelope is None:
        return {"exists": False, "points": []}
    count = args["points"]
    points = []
    for step in range(count):
        time = start + (end - start) * step / (count - 1)
        points.append({"time": time, "value": float(envelope.value_at_time(time))})
    return {"exists": True, "points": points}


# ----------------------------------------------------------------- envelope_set

def _set_check(ctx, args):
    target = _session_clip(ctx, args)
    param = _param_of(ctx, target, args)
    length = float(target.clip.length)
    for index, step in enumerate(args["steps"]):
        label = "steps[%d]" % index
        if step["time"] > length:
            raise lom.out_of_range(label + ".time", 0, length, step["time"])
        if step["time"] + step["duration"] > length + TIME_TOLERANCE:
            raise lom.out_of_range(label + ".duration", 0, length - step["time"], step["duration"])
        lom.checked_value(label + ".value", param, step["value"])
    return target, param


def _envelope_set(ctx, args):
    target, param = _set_check(ctx, args)
    clip = target.clip
    envelope = clip.automation_envelope(param)
    ctx.note_mutation()
    if args["replace"] and envelope is not None:
        clip.clear_envelope(param)
        envelope = None
    if envelope is None:
        envelope = clip.create_automation_envelope(param)
    if envelope is None:
        raise BatutaError("lom_error", "create_automation_envelope returned no envelope",
                          {"exception": "NoEnvelope", "partial": True})
    for step in args["steps"]:
        envelope.insert_step(float(step["time"]), float(step["duration"]), float(step["value"]))
    return {"inserted": len(args["steps"])}


# ----------------------------------------------------------------- envelope_clear / envelope_clear_all

def _clear_check(ctx, args):
    target = _session_clip(ctx, args)
    return target, _param_of(ctx, target, args)


def _envelope_clear(ctx, args):
    target, param = _clear_check(ctx, args)
    ctx.note_mutation()
    target.clip.clear_envelope(param)
    return {}


def _clear_all_check(ctx, args):
    return _session_clip(ctx, args)


def _envelope_clear_all(ctx, args):
    target = _clear_all_check(ctx, args)
    ctx.note_mutation()
    target.clip.clear_all_envelopes()
    return {}


# ----------------------------------------------------------------- registration

def install(registry):
    reg = registry.register
    clip = clip_lom.CLIP_REF
    param = device_path.PARAM_REF
    step = v.obj({"time": v.number(min=0), "duration": v.number(min=0, exclusive_min=True),
                  "value": v.number()}, required=["time", "duration", "value"])
    reg(Command("envelope_list", v.obj({"clip": clip}, required=["clip"]), _envelope_list))
    reg(Command("envelope_get", v.obj({
        "clip": clip, "param": param, "from": v.with_default(v.number(min=0), 0), "to": v.number(min=0),
        "points": v.with_default(v.integer(min=2, max=512), 128)}, required=["clip", "param"]),
        _envelope_get))
    reg(Command("envelope_set", v.obj({
        "clip": clip, "param": param, "steps": v.array(step, min_items=1, max_items=1024),
        "replace": v.with_default(v.boolean(), False)}, required=["clip", "param", "steps"]),
        _envelope_set, mutating=True, destructive="conditional", conditions=("replace",),
        precheck=_set_check))
    reg(Command("envelope_clear", v.obj({"clip": clip, "param": param}, required=["clip", "param"]),
                _envelope_clear, mutating=True, destructive="always", precheck=_clear_check))
    reg(Command("envelope_clear_all", v.obj({"clip": clip}, required=["clip"]), _envelope_clear_all,
                mutating=True, destructive="always", precheck=_clear_all_check))
