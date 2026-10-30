"""Racks, chains and drum pads (docs/01-protocol.md section 7.9).

Same shape as the other command groups: a `check` per mutating command (precheck and first step of
the handler, so `batch` repeats it per op) and `ctx.note_mutation()` right before the first write.
The gain guard for chain volume (section 9.4) lives in the TypeScript server; the script supplies
the display and dB text in every chain `volume` object, and `volume_db` as a way to set a dB target
exactly like `mixer_set` (an additive optional arg, protocol 1 stays valid).
"""

from . import device_path, lom
from . import validator as v
from .errors import BatutaError
from .mixer_commands import DB_MAX, DB_MIN
from .registry import Command

CHAIN_REF = v.obj({"kind": v.enum("chain", "return_chain"), "index": v.integer(min=0)},
                  required=["kind", "index"])
NOTE = v.integer(min=0, max=127)


def _unsupported(what):
    return BatutaError("not_supported", "this Live version cannot %s" % what, {"reason": "live_version"})


# ----------------------------------------------------------------- resolution

def _rack(ctx, ref):
    _, device = device_path.resolve_device(ctx.song, ref)
    if lom.safe(lambda: device.can_have_chains) is not True:
        raise lom.invalid("not_a_rack", "this device is not a rack")
    return device


def _drum_rack(ctx, ref):
    _, device = device_path.resolve_device(ctx.song, ref)
    if lom.safe(lambda: device.can_have_drum_pads) is not True:
        raise lom.invalid("not_a_drum_rack", "this device is not a drum rack")
    return device


def _chain(device, ref):
    index = ref["index"]
    chains = lom.safe(lambda: list(device.chains if ref["kind"] == "chain" else device.return_chains), [])
    if index >= len(chains):
        raise lom.not_found(ref["kind"], index)
    return chains[index]


def _pad(device, note):
    pads = lom.safe(lambda: list(device.drum_pads), [])
    pad = next((p for p in pads if lom.safe(lambda: p.note) == note), None)
    if pad is None:
        raise lom.not_found("drum_pad", note)
    return pad


# ----------------------------------------------------------------- builders

def chain_info(index, chain):
    mixer = chain.mixer_device
    return {
        "index": index, "name": lom.text(lom.safe(lambda: chain.name)),
        "color": lom.as_int(lom.safe(lambda: chain.color)),
        "mute": lom.as_bool(lom.safe(lambda: chain.mute)), "solo": lom.as_bool(lom.safe(lambda: chain.solo)),
        "device_count": len(lom.safe(lambda: list(chain.devices), [])),
        "volume": lom.volume_json(mixer.volume), "pan": lom.param_json(mixer.panning),
    }


def pad_info(pad):
    return {
        "note": lom.as_int(lom.safe(lambda: pad.note)), "name": lom.text(lom.safe(lambda: pad.name)),
        "mute": lom.as_bool(lom.safe(lambda: pad.mute)), "solo": lom.as_bool(lom.safe(lambda: pad.solo)),
        "chain_count": len(lom.safe(lambda: list(pad.chains), [])),
    }


def _variation_state(device):
    return {"variation_count": lom.as_int(lom.safe(lambda: device.variation_count)),
            "selected_variation": lom.as_int(lom.safe(lambda: device.selected_variation_index))}


# ----------------------------------------------------------------- rack_get

def _macro_count(device):
    visible = lom.safe(lambda: device.visible_macro_count)
    if visible is not None:
        return int(visible)
    mapped = lom.safe(lambda: list(device.macros_mapped))
    return None if mapped is None else len(mapped)


def _rack_get(ctx, args):
    device = _rack(ctx, args["device"])
    result = {
        "chains": [chain_info(i, c) for i, c in enumerate(lom.safe(lambda: list(device.chains), []))],
        "return_chains": [chain_info(i, c)
                          for i, c in enumerate(lom.safe(lambda: list(device.return_chains), []))],
        "macro_count": _macro_count(device),
        "can_have_drum_pads": lom.as_bool(lom.safe(lambda: device.can_have_drum_pads)),
    }
    result.update(_variation_state(device))
    return result


# ----------------------------------------------------------------- chain_set

def _chain_set_check(ctx, args):
    """-> (chain, [(parameter, value)]) after validating every field; nothing is written."""
    device = _rack(ctx, args["device"])
    chain = _chain(device, args["chain"])
    if not any(field in args for field in ("name", "color", "mute", "solo", "volume", "volume_db", "pan")):
        raise lom.invalid("at_least_one", "give at least one field to change")
    mixer = chain.mixer_device
    writes = []
    if "volume" in args:
        writes.append((mixer.volume, lom.checked_value("volume", mixer.volume, args["volume"])))
    if "volume_db" in args:
        target = args["volume_db"]
        if not DB_MIN <= target <= DB_MAX:
            raise lom.out_of_range("volume_db", DB_MIN, DB_MAX, target)
        writes.append((mixer.volume, lom.raw_for_db(mixer.volume, target)))
    if "pan" in args:
        writes.append((mixer.panning, lom.checked_value("pan", mixer.panning, args["pan"])))
    return chain, writes


def _chain_set(ctx, args):
    chain, writes = _chain_set_check(ctx, args)
    ctx.note_mutation()
    if "name" in args:
        chain.name = args["name"]
    if "color" in args:
        chain.color = args["color"]
    if "mute" in args:
        chain.mute = args["mute"]
    if "solo" in args:
        chain.solo = args["solo"]
    for param, value in writes:
        param.value = value
    return {"chain": chain_info(args["chain"]["index"], chain)}


# ----------------------------------------------------------------- rack_insert_chain

def _insert_chain_check(ctx, args):
    device = _rack(ctx, args["device"])
    if getattr(device, "insert_chain", None) is None:
        raise _unsupported("insert chains")
    count = len(lom.safe(lambda: list(device.chains), []))
    index = count if args["index"] == -1 else args["index"]
    if index > count:
        raise lom.out_of_range("index", -1, count, args["index"])
    return device, index


def _rack_insert_chain(ctx, args):
    device, index = _insert_chain_check(ctx, args)
    before = lom.safe(lambda: list(device.chains), [])
    ctx.note_mutation()
    device.insert_chain(index)
    after = lom.safe(lambda: list(device.chains), [])
    created = lom.new_items(before, after)
    if not created:
        raise BatutaError("lom_error", "the chain was not added", {"partial": True})
    return {"chain": chain_info(lom.position_of(after, created[0]), created[0])}


# ----------------------------------------------------------------- rack_variation

def _variation_prepare(args, registry):
    needs_index = args["action"] in ("recall", "delete")
    if needs_index and "index" not in args:
        raise lom.invalid("index_required", "this action needs a variation index")
    if not needs_index and "index" in args:
        raise lom.invalid("index_not_allowed", "this action takes no variation index")
    return args


def _variation_method(device, action):
    """The Live method behind an action, or None on a Live version without it (assumption A28)."""
    if action == "store":
        return getattr(device, "store_variation", None)
    if action == "recall":
        return getattr(device, "recall_selected_variation", None)
    if action == "delete":
        return getattr(device, "delete_selected_variation", None)
    return getattr(device, "randomize_macros", None)


def _variation_check(ctx, args):
    device = _rack(ctx, args["device"])
    if _variation_method(device, args["action"]) is None:
        raise _unsupported("use rack variations")
    if "index" in args:
        count = lom.safe(lambda: device.variation_count, 0)
        if not 0 <= args["index"] < count:
            raise lom.out_of_range("index", 0, count - 1, args["index"])
    return device


def _rack_variation(ctx, args):
    device = _variation_check(ctx, args)
    action = args["action"]
    ctx.note_mutation()
    if action == "store":
        device.store_variation()
    elif action == "randomize":
        device.randomize_macros()
    else:
        device.selected_variation_index = args["index"]
        if action == "recall":
            device.recall_selected_variation()
        else:
            device.delete_selected_variation()
    return _variation_state(device)


# ----------------------------------------------------------------- drum pads

def _pads_list(ctx, args):
    device = _drum_rack(ctx, args["device"])
    pads = lom.safe(lambda: list(device.drum_pads), [])
    shown = [pad_info(pad) for pad in pads]
    if not args["all"]:
        shown = [info for info in shown if info["chain_count"] > 0]
    return lom.page(shown, args, lambda _, info: info)


def _pad_set_check(ctx, args):
    device = _drum_rack(ctx, args["device"])
    pad = _pad(device, args["note"])
    if "mute" not in args and "solo" not in args:
        raise lom.invalid("at_least_one", "give mute or solo")
    return pad


def _pad_set(ctx, args):
    pad = _pad_set_check(ctx, args)
    ctx.note_mutation()
    if "mute" in args:
        pad.mute = args["mute"]
    if "solo" in args:
        pad.solo = args["solo"]
    return {"pad": pad_info(pad)}


def _pad_copy_check(ctx, args):
    device = _drum_rack(ctx, args["device"])
    if args["from_note"] == args["to_note"]:
        raise lom.invalid("same_pad", "the source and target pads are the same")
    _pad(device, args["from_note"])
    _pad(device, args["to_note"])
    if getattr(device, "copy_pad", None) is None:
        raise _unsupported("copy pads")
    return device


def _pad_copy(ctx, args):
    device = _pad_copy_check(ctx, args)
    ctx.note_mutation()
    device.copy_pad(args["from_note"], args["to_note"])
    return {"pad": pad_info(_pad(device, args["to_note"]))}


def _pad_clear_check(ctx, args):
    device = _drum_rack(ctx, args["device"])
    pad = _pad(device, args["note"])
    if getattr(pad, "delete_all_chains", None) is None:
        raise _unsupported("clear pads")
    return pad


def _pad_clear(ctx, args):
    pad = _pad_clear_check(ctx, args)
    ctx.note_mutation()
    pad.delete_all_chains()
    return {}


# ----------------------------------------------------------------- registration

def install(registry):
    reg = registry.register
    device = device_path.DEVICE_REF
    reg(Command("rack_get", v.obj({"device": device}, required=["device"]), _rack_get))
    reg(Command("chain_set", v.obj({
        "device": device, "chain": CHAIN_REF, "name": lom.NAME, "color": lom.COLOR, "mute": v.boolean(),
        "solo": v.boolean(), "volume": v.number(), "volume_db": v.number(), "pan": v.number(),
    }, required=["device", "chain"], exclusive=[("volume", "volume_db")]), _chain_set, mutating=True,
        destructive="conditional", conditions=("volume", "volume_db"), precheck=_chain_set_check))
    reg(Command("rack_insert_chain", v.obj({
        "device": device, "index": v.with_default(v.integer(min=-1), -1)}, required=["device"]),
        _rack_insert_chain, mutating=True, precheck=_insert_chain_check))
    reg(Command("rack_variation", v.obj({
        "device": device, "action": v.enum("store", "recall", "delete", "randomize"),
        "index": v.integer(min=0)}, required=["device", "action"]), _rack_variation, mutating=True,
        destructive="conditional", conditions=("action",), prepare=_variation_prepare,
        precheck=_variation_check))
    reg(Command("drum_pads_list", v.obj(dict({"device": device, "all": v.with_default(v.boolean(), False)},
                                             **v.PAGING_PROPS), required=["device"]), _pads_list))
    reg(Command("drum_pad_set", v.obj({"device": device, "note": NOTE, "mute": v.boolean(),
                                       "solo": v.boolean()}, required=["device", "note"]),
                _pad_set, mutating=True, precheck=_pad_set_check))
    reg(Command("drum_pad_copy", v.obj({"device": device, "from_note": NOTE, "to_note": NOTE},
                                       required=["device", "from_note", "to_note"]), _pad_copy,
                mutating=True, destructive="always", precheck=_pad_copy_check))
    reg(Command("drum_pad_clear", v.obj({"device": device, "note": NOTE}, required=["device", "note"]),
                _pad_clear, mutating=True, destructive="always", precheck=_pad_clear_check))
