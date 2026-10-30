"""DeviceRef, ContainerRef and ParamRef resolution (spec 6.1), read-only.

Written for the clip envelope commands (T4a); the device and rack commands (T4b) reuse the same
shapes. A DeviceRef path is `[device_index, step, step, ...]`; a step is `{chain, device}`,
`{return_chain, device}` or `{drum_pad, chain, device}`. A ContainerRef path may be empty (the
track's own chain) and its last step may omit `device` to name a chain. Names are never selectors.
"""

from . import limits
from . import lom
from . import validator as v

MAX_PATH_DEPTH = 8
MAX_WALK_DEVICES = 500

_INDEX = v.integer(min=0)
STEP = v.one_of(
    v.obj({"chain": _INDEX, "device": _INDEX}, required=["chain", "device"]),
    v.obj({"return_chain": _INDEX, "device": _INDEX}, required=["return_chain", "device"]),
    v.obj({"drum_pad": v.integer(min=0, max=127), "chain": _INDEX, "device": _INDEX},
          required=["drum_pad", "chain", "device"]),
)
CONTAINER_STEP = v.one_of(
    STEP,
    v.obj({"chain": _INDEX}, required=["chain"]),
    v.obj({"return_chain": _INDEX}, required=["return_chain"]),
    v.obj({"drum_pad": v.integer(min=0, max=127), "chain": _INDEX}, required=["drum_pad", "chain"]),
)
CONTAINER_REF = v.obj({
    "track": v.TRACK_REF,
    "path": v.array(v.one_of(_INDEX, CONTAINER_STEP), max_items=MAX_PATH_DEPTH),
}, required=["track", "path"])
DEVICE_REF = v.obj({
    "track": v.TRACK_REF,
    "path": v.array(v.one_of(_INDEX, STEP), min_items=1, max_items=MAX_PATH_DEPTH),
}, required=["track", "path"])
PARAM_REF = v.one_of(
    v.obj({"device": DEVICE_REF, "index": _INDEX}, required=["device", "index"]),
    v.obj({"mixer": v.enum("volume", "pan", "send"), "track": v.TRACK_REF, "index": _INDEX},
          required=["mixer", "track"]),
)


def _bad_path(message):
    return lom.invalid("bad_path", message)


def _chain_for(device, step):
    """The chain object a step names; not_found when the rack, pad or chain is absent."""
    if "drum_pad" in step:
        pads = lom.safe(lambda: list(device.drum_pads), [])
        pad = next((p for p in pads if lom.safe(lambda: p.note) == step["drum_pad"]), None)
        if pad is None:
            raise lom.not_found("drum_pad", step["drum_pad"])
        chains = lom.safe(lambda: list(pad.chains), [])
        what, index = "chain", step["chain"]
    elif "return_chain" in step:
        chains = lom.safe(lambda: list(device.return_chains), [])
        what, index = "return_chain", step["return_chain"]
    else:
        chains = lom.safe(lambda: list(device.chains), [])
        what, index = "chain", step["chain"]
    if index >= len(chains):
        raise lom.not_found(what, index)
    return chains[index]


def resolve_device_owned(song, ref):
    """DeviceRef -> (track, device, owner, index): `owner` is the track or chain holding the device."""
    track = lom.resolve_track(song, ref["track"])
    path = ref["path"]
    if type(path[0]) is not int:
        raise _bad_path("the first path item must be a device index")
    owner = track
    for hop, item in enumerate(path):
        if hop > 0:
            if type(item) is not dict or "device" not in item:
                raise _bad_path("later path items must be chain steps with a device")
            owner = _chain_for(device, item)
        devices = lom.safe(lambda: list(owner.devices), [])
        index = item if hop == 0 else item["device"]
        if index >= len(devices):
            raise lom.not_found("device", index)
        device = devices[index]
    return track, device, owner, index


def resolve_device(song, ref):
    """DeviceRef -> (track, device). Out-of-range hops are not_found, a malformed path invalid_args."""
    track, device, _, _ = resolve_device_owned(song, ref)
    return track, device


class Container:
    """A device list that accepts devices: the track's own chain or one chain of a rack.

    `owner` has `devices`, `insert_device` and (on newer Live) `delete_device`; `path` is the
    ContainerRef path, from which child device paths are built."""

    def __init__(self, track, owner, path):
        self.track = track
        self.owner = owner
        self.path = path

    def devices(self):
        return lom.safe(lambda: list(self.owner.devices), [])

    def child_path(self, index):
        if not self.path:
            return [index]
        return self.path[:-1] + [dict(self.path[-1], device=index)]


def _check_container_shape(path):
    """The first item is a device index, middle steps carry a device, the last step names a chain."""
    if not path:
        return
    if type(path[0]) is not int:
        raise _bad_path("the first path item must be a device index")
    if len(path) == 1 or type(path[-1]) is not dict or "device" in path[-1]:
        raise lom.invalid("not_a_container", "the path must end with a chain step without a device")
    if any(type(item) is not dict or "device" not in item for item in path[1:-1]):
        raise _bad_path("only the last path step may omit the device")


def resolve_container(song, ref):
    """ContainerRef -> Container. Shape errors are invalid_args, absent hops are not_found."""
    path = ref["path"]
    _check_container_shape(path)
    track = lom.resolve_track(song, ref["track"])
    if not path:
        return Container(track, track, path)
    _, device, _, _ = resolve_device_owned(song, {"track": ref["track"], "path": path[:-1]})
    return Container(track, _chain_for(device, path[-1]), path)


def resolve_param(song, ref):
    """ParamRef -> (track, parameter)."""
    if "device" in ref:
        track, device = resolve_device(song, ref["device"])
        parameters = lom.safe(lambda: list(device.parameters), [])
        if ref["index"] >= len(parameters):
            raise lom.not_found("parameter", ref["index"])
        return track, parameters[ref["index"]]
    track = lom.resolve_track(song, ref["track"])
    kind = ref["mixer"]
    if kind != "send" and "index" in ref:
        raise lom.invalid("index_only_for_send", "index only applies to mixer:send")
    mixer = track.mixer_device
    if kind == "volume":
        return track, mixer.volume
    if kind == "pan":
        return track, mixer.panning
    if "index" not in ref:
        raise lom.invalid("send_needs_index", "mixer:send needs an index")
    sends = lom.safe(lambda: list(mixer.sends), [])
    if ref["index"] >= len(sends):
        raise lom.not_found("send", ref["index"])
    return track, sends[ref["index"]]


def walk_devices(track):
    """[(path, device)] for the track's devices and everything nested in racks (depth and count capped)."""
    nodes, _ = walk_owned(track)
    return [(path, device) for path, device, _, _ in nodes]


def walk_owned(track):
    """([(path, device, owner, index)], truncated) for the whole device tree of a track.

    `owner` is the track or chain holding the device, `index` its position there. `truncated` is
    True when the depth or count cap left devices unseen, so callers that need certainty fail closed."""
    found = []
    cut = [False]
    _walk(track, lom.safe(lambda: list(track.devices), []), [], found, cut)
    return found, cut[0]


def _chains_of(device):
    """[(step_prefix, chain)] for the chains, return chains and drum-pad chains of a device."""
    chains = []
    if lom.safe(lambda: device.can_have_drum_pads) is not True:  # a drum rack's chains mirror its pads
        chains += [({"chain": i}, c) for i, c in enumerate(lom.safe(lambda: list(device.chains), []))]
    chains += [({"return_chain": i}, c)
               for i, c in enumerate(lom.safe(lambda: list(device.return_chains), []))]
    for pad in lom.safe(lambda: list(device.drum_pads), []):
        note = lom.safe(lambda: pad.note)
        chains += [({"drum_pad": note, "chain": i}, c)
                   for i, c in enumerate(lom.safe(lambda: list(pad.chains), []))]
    return chains


def _walk(owner, devices, prefix, found, cut):
    for index, device in enumerate(devices):
        if len(found) >= MAX_WALK_DEVICES:
            cut[0] = True
            return
        path = [index] if not prefix else prefix[:-1] + [dict(prefix[-1], device=index)]
        found.append((path, device, owner, index))
        nested = _chains_of(device)
        if len(path) >= MAX_PATH_DEPTH:
            if any(lom.safe(lambda: list(c.devices), []) for _, c in nested):
                cut[0] = True
            continue
        for step, chain in nested:
            _walk(chain, lom.safe(lambda: list(chain.devices), []), path + [step], found, cut)


def param_ref_json(track_ref, path, index, name):
    """A ParamRef result object for a device parameter, plus its name."""
    return {"device": {"track": track_ref, "path": path}, "index": index,
            "name": lom.text(name, limits.MAX_NAME_CHARS)}
