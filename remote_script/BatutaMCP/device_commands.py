"""Devices and parameters (docs/01-protocol.md section 7.8).

Each mutating command has a `check` that resolves references and runs the policy guards without
touching the Live Object Model. It is the precheck (a refusal never opens an undo step) and is
called again at the start of the handler so the same guards hold per op inside `batch`.
`ctx.note_mutation()` comes right before the first write. The gain guard of section 9.4 lives in
the TypeScript server; this script supplies what it needs: `display` on every ParamInfo and
`display_at_value` from `param_get {at_value}`.
"""

from . import content_policy, device_path, lom
from . import validator as v
from .errors import BatutaError
from .registry import Command

MAX_PARAMS_PER_GET = 128
MAX_PARAMS_PER_SET = 64
DEVICE_ON = "Device On"
_UNKNOWN_DEVICE_HINTS = ("not found", "no such", "unknown", "invalid device")
_AUTOMATION_STATES = {0: "none", 1: "active", 2: "overridden"}

INSERT_NAME = v.string(max_chars=64, pattern=r"^[A-Za-z0-9 '&()+./-]{1,64}\Z")
_PARAM_VALUE = v.number()


# ----------------------------------------------------------------- shared builders

def param_info(index, param):
    """ParamInfo (spec 6.3). `index` is None for mixer parameters that have no index."""
    value = param.value
    quantized = lom.as_bool(lom.safe(lambda: param.is_quantized))
    items = None
    if quantized:
        items = [lom.text(item, 64) for item in lom.safe(lambda: list(param.value_items), [])
                 [:lom.MAX_LISTED_OPTIONS]]
    return {
        "index": index, "name": lom.text(lom.safe(lambda: param.name)), "value": float(value),
        "min": float(param.min), "max": float(param.max),
        "default": lom.as_float(lom.safe(lambda: param.default_value)),
        "display": lom.text(param.str_for_value(value), 64),
        "is_quantized": quantized, "value_items": items,
        "is_enabled": lom.as_bool(lom.safe(lambda: param.is_enabled)),
        "automation_state": _AUTOMATION_STATES.get(lom.safe(lambda: param.automation_state)),
    }


def device_name(device):
    return lom.text(lom.safe(lambda: device.name))


# ----------------------------------------------------------------- reads

def _device_list(ctx, args):
    container = device_path.resolve_container(ctx.song, args["container"])
    devices = container.devices()
    return lom.page(devices, args, lambda position, device:
                    lom.device_info(container.child_path(position), device))


def _device_get(ctx, args):
    _, device = device_path.resolve_device(ctx.song, args["device"])
    parameters = lom.safe(lambda: list(device.parameters), [])
    start = args["offset"]
    stop = min(len(parameters), start + args["limit"])
    return {
        "device": lom.device_info(list(args["device"]["path"]), device),
        "parameters": [param_info(index, parameters[index]) for index in range(start, stop)],
        "total": len(parameters), "next_offset": stop if stop < len(parameters) else None,
    }


def _param_get(ctx, args):
    ref = args["param"]
    _, param = device_path.resolve_param(ctx.song, ref)
    result = param_info(ref.get("index"), param)
    result["display_at_value"] = None
    if "at_value" in args:
        at_value = lom.checked_value("at_value", param, args["at_value"])
        result["display_at_value"] = lom.text(param.str_for_value(at_value), 64)
    return result


# ----------------------------------------------------------------- param_set

def _param_set_prepare(args, registry):
    items_form = "device" in args and "items" in args and "param" not in args and "value" not in args
    param_form = "param" in args and "value" in args and "device" not in args and "items" not in args
    if not items_form and not param_form:
        raise lom.invalid("form", "give either device and items, or param and value")
    return args


def _check_settable(param, value):
    if lom.safe(lambda: param.is_enabled) is not True:
        raise lom.invalid("parameter_disabled", "this parameter is disabled")
    lom.checked_value("value", param, value)
    if lom.safe(lambda: param.is_quantized) is True and float(value) != int(value):
        raise lom.invalid("quantized_needs_integer", "this parameter needs a whole number")


def _param_set_check(ctx, args):
    """-> [(index, parameter, value)] after validating every item; nothing is written."""
    if "items" in args:
        _, device = device_path.resolve_device(ctx.song, args["device"])
        parameters = lom.safe(lambda: list(device.parameters), [])
        seen = set()
        plan = []
        for item in args["items"]:
            index = item["index"]
            if index in seen:
                raise lom.invalid("duplicate_index", "a parameter index appears twice", index=index)
            seen.add(index)
            if index >= len(parameters):
                raise lom.not_found("parameter", index)
            plan.append((index, parameters[index], item["value"]))
    else:
        _, param = device_path.resolve_param(ctx.song, args["param"])
        plan = [(args["param"].get("index"), param, args["value"])]
    for _, param, value in plan:
        _check_settable(param, value)
    return plan


def _param_set(ctx, args):
    plan = _param_set_check(ctx, args)
    ctx.note_mutation()
    for _, param, value in plan:
        param.value = value
    return {"params": [param_info(index, param) for index, param, _ in plan]}


# ----------------------------------------------------------------- device_enable

def _enable_check(ctx, args):
    _, device = device_path.resolve_device(ctx.song, args["device"])
    parameters = lom.safe(lambda: list(device.parameters), [])
    if not parameters or lom.text(lom.safe(lambda: parameters[0].name)) != DEVICE_ON:
        raise lom.not_found("parameter", 0, "device_on_missing")
    return device, parameters[0]


def _device_enable(ctx, args):
    device, switch = _enable_check(ctx, args)
    ctx.note_mutation()
    switch.value = 1.0 if args["enabled"] else 0.0
    return {"device": lom.device_info(list(args["device"]["path"]), device)}


# ----------------------------------------------------------------- device_delete

def _delete_check(ctx, args):
    _, device, owner, index = device_path.resolve_device_owned(ctx.song, args["device"])
    expected = args.get("expect_name")
    if expected is not None and device_name(device) != expected:
        raise lom.not_found("device", index, "name_mismatch")
    if getattr(owner, "delete_device", None) is None:
        raise BatutaError("not_supported", "this Live version cannot delete devices in chains",
                          {"reason": "live_version"})
    return device, owner, index


def _device_delete(ctx, args):
    device, owner, index = _delete_check(ctx, args)
    name = device_name(device)
    ctx.note_mutation()
    owner.delete_device(index)
    return {"deleted": {"name": name}}


# ----------------------------------------------------------------- device_insert

def _insert_check(ctx, args):
    """-> (container, index, baseline). Names that could bring in Max, External or Live-set content are
    refused before the call (7.8), and so is a track whose tree cannot be fully seen; the new device
    tree is checked again after the call."""
    reason = content_policy.blocked_insert_name(args["name"], ctx.flags.get("allow_max_for_live") is True,
                                                  ctx.flags.get("allow_external_devices") is True)
    if reason is not None:
        raise BatutaError("not_supported", "this device cannot be inserted",
                          {"reason": "blocked_content", "blocked": reason})
    container = device_path.resolve_container(ctx.song, args["container"])
    if getattr(container.owner, "insert_device", None) is None:
        raise BatutaError("not_supported", "this Live version cannot insert devices here",
                          {"reason": "live_version"})
    if content_policy.names_external_device(args["name"]):  # allowed above, so it is the flag that lets it in
        ctx.recording.check_external_insert(container.track, "device_insert")  # asks while a recording is possible
    count = len(container.devices())
    index = args["index"]
    if index == -1:
        index = count
    elif index > count:
        raise lom.out_of_range("index", -1, count, args["index"])
    baseline = content_policy.snapshot(container.track)
    content_policy.require_visible(baseline)
    return container, index, baseline


def _device_insert(ctx, args):
    container, index, baseline = _insert_check(ctx, args)
    track = container.track
    siblings = container.devices()
    ctx.note_mutation()
    try:
        container.owner.insert_device(args["name"], index)
    except BatutaError:
        raise
    except Exception as exc:
        if not any(hint in str(exc).lower() for hint in _UNKNOWN_DEVICE_HINTS):
            raise  # a limit or any other failure keeps its own code (lom_error, partial)
        raise BatutaError("not_found", "no built-in device with this name",
                          {"what": "device", "reason": "unknown_device",
                           "exception": type(exc).__name__}) from exc
    reasons, verified = content_policy.purge_new_devices(track, baseline, False,
                                                           allow_max=ctx.flags.get("allow_max_for_live") is True,
                                                           allow_external=(ctx.flags.get("allow_external_devices") is True
                                                                           and ctx.recording.external_allowed_on(track)))
    if not verified and container.owner is not track:
        _delete_new_siblings(container, siblings)  # the new device sits in a chain, not at top level
    if reasons or not verified:
        raise content_policy.blocked(reasons, verified)
    after = container.devices()
    created = lom.new_items(siblings, after)
    if not created:
        raise BatutaError("lom_error", "the device was not added", {"partial": True})
    position = lom.position_of(after, created[0])
    return {"device": lom.device_info(container.child_path(position), created[0])}


def _delete_new_siblings(container, before):
    after = container.devices()
    new = lom.new_items(before, after)
    for index in reversed([i for i, device in enumerate(after) if any(device is item for item in new)]):
        container.owner.delete_device(index)


# ----------------------------------------------------------------- registration

def install(registry):
    reg = registry.register
    device = device_path.DEVICE_REF
    paging = v.PAGING_PROPS
    reg(Command("device_list", v.obj(dict({"container": device_path.CONTAINER_REF}, **paging),
                                     required=["container"]), _device_list))
    reg(Command("device_get", v.obj({
        "device": device, "limit": v.with_default(v.integer(min=1, max=MAX_PARAMS_PER_GET), MAX_PARAMS_PER_GET),
        "offset": v.with_default(v.integer(min=0), 0)}, required=["device"]), _device_get))
    reg(Command("param_get", v.obj({"param": device_path.PARAM_REF, "at_value": _PARAM_VALUE},
                                   required=["param"]), _param_get))
    reg(Command("param_set", v.obj({
        "device": device,
        "items": v.array(v.obj({"index": v.integer(min=0), "value": _PARAM_VALUE},
                               required=["index", "value"]), min_items=1, max_items=MAX_PARAMS_PER_SET),
        "param": device_path.PARAM_REF, "value": _PARAM_VALUE,
    }), _param_set, mutating=True, destructive="conditional", conditions=("value", "items"),
        prepare=_param_set_prepare, precheck=_param_set_check))
    reg(Command("device_enable", v.obj({"device": device, "enabled": v.boolean()},
                                       required=["device", "enabled"]), _device_enable,
                mutating=True, precheck=_enable_check))
    reg(Command("device_delete", v.obj({"device": device, "expect_name": lom.NAME}, required=["device"]),
                _device_delete, mutating=True, destructive="always", precheck=_delete_check))
    reg(Command("device_insert", v.obj({
        "container": device_path.CONTAINER_REF, "name": INSERT_NAME,
        "index": v.with_default(v.integer(min=-1), -1)}, required=["container", "name"]),
        _device_insert, mutating=True, precheck=_insert_check))
