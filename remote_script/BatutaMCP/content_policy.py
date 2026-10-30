"""Device content policy (docs/01-protocol.md sections 7.8 and 7.10): block and clean up.

Two layers protect the set from Max for Live, plugin and External devices (each is blocked only while
its flag `allow_max_for_live` / `allow_external_devices` is off):

  1. `blocked_insert_name` refuses names BEFORE the Live call (device_insert).
  2. `purge_new_devices` walks the track's device tree AFTER a load or insert and deletes every NEW
     offending device, in chains, return chains and drum pads. This is cleanup only: it cannot stop
     code that already ran while the item loaded (documented risk, spec 7.10).

Devices are classified by `class_name` (assumption A24: Max devices start with `Max` or `MxDevice`,
plugin devices have a class containing `Plugin`) and by the External class/device names (A38). An
unreadable class name is not classifiable, so it counts as an offence (fail closed).
"""

from . import device_path, lom
from .errors import BatutaError
from .recording_safety import is_external_device

MAX_PURGE_ROUNDS = 64
_MAX_CLASS_PREFIXES = ("max", "mxdevice")


def blocked_insert_name(name, allow_max=False, allow_external=False):
    """Reason a built-in device name may not be inserted, or None.

    The name is reduced to lower-case letters and digits, so spacing and punctuation cannot dodge the
    prefixes max / m4l (Max for Live, skipped when `allow_max`), external and proxy (External devices)."""
    lowered = name.casefold()
    if ".amxd" in lowered and not allow_max:
        return "max_for_live"
    if ".als" in lowered:
        return "live_set"
    key = "".join(ch for ch in lowered if ch.isalnum())
    if key.startswith(("external", "proxy")) and not allow_external:
        return "external_device"
    if key.startswith(("max", "m4l")) and not allow_max:
        return "max_for_live"
    return None


def names_external_device(name):
    """True when a built-in device name would insert an External device (same reduction as above)."""
    key = "".join(ch for ch in name.casefold() if ch.isalnum())
    return key.startswith(("external", "proxy"))


def offence(device, allow_plugins, allow_max=False, allow_external=False):
    """Why a loaded device must go (max_for_live, plugin, external_device, unclassifiable) or None."""
    class_name = lom.safe(lambda: device.class_name)
    if not isinstance(class_name, str):
        return "unclassifiable"
    if is_external_device(device) and not allow_external:
        return "external_device"
    key = class_name.casefold()
    if key.startswith(_MAX_CLASS_PREFIXES) and not allow_max:
        return "max_for_live"
    if "plugin" in key and not allow_plugins:
        return "plugin"
    return None


class Baseline:
    """What a track held before a load or insert: every device (nested ones too), the top-level list
    (always fully visible) and whether the walk caps hid part of the tree. `Baseline(None)` is the
    empty baseline of a track that did not exist yet (everything on it is new)."""

    def __init__(self, track):
        if track is None:
            self.devices, self.top, self.truncated = [], [], False
            return
        nodes, self.truncated = device_path.walk_owned(track)
        self.devices = [node[1] for node in nodes]
        self.top = lom.safe(lambda: list(track.devices), [])


def changed(old, new):
    """True when the device tree differs from the baseline (a device appeared or went away)."""
    return len(old.devices) != len(new.devices) or bool(lom.new_items(old.devices, new.devices))


def snapshot(track):
    return Baseline(track)


def require_visible(baseline):
    """Refuse BEFORE a load or insert when the existing tree cannot be fully seen: nothing new in it
    could be told apart from what was already there."""
    if baseline.truncated:
        raise BatutaError("not_supported", "the device tree is too large to verify",
                          {"reason": "tree_too_large"})


def purge_new_devices(track, baseline, allow_plugins, only=None, allow_max=False, allow_external=False):
    """Delete every new offending device. Returns (reasons, verified).

    `verified` is False when the walk caps hid part of the new tree: then every NEW top-level device is
    deleted (the top-level list is always fully visible; existing devices are matched by == in
    position order and never touched), because nothing inside them can be vouched for.

    `only` (a list of top-level device objects) narrows the cleanup to those devices and everything
    nested in them; other new devices are left alone (used by the sweep, see sweep.py). `allow_max` keeps
    Max for Live devices and `allow_external` keeps External devices (the plugin rule is unaffected)."""
    reasons = []
    for _ in range(MAX_PURGE_ROUNDS):
        nodes, truncated = device_path.walk_owned(track)
        new = lom.new_items(baseline.devices, [node[1] for node in nodes])
        fresh = [node for node in nodes if _is_in(new, node[1]) and _in_scope(nodes, node, only)]
        if truncated:
            delete_new_top_level(track, baseline, only)
            return reasons + ["tree_too_large"], False
        bad = next((node for node in fresh if offence(node[1], allow_plugins, allow_max, allow_external)), None)
        if bad is None:
            return reasons, True
        reasons.append(offence(bad[1], allow_plugins, allow_max, allow_external))
        _delete_node(track, nodes, new, bad)
    raise BatutaError("lom_error", "device cleanup did not converge", {"partial": True})


def _in_scope(nodes, node, only):
    if only is None:
        return True
    top = next((other[1] for other in nodes if other[0] == node[0][:1]), None)
    return top is not None and _is_in(only, top)


def delete_new_top_level(track, baseline, only=None):
    """Delete the top-level devices that were not there before, highest position first."""
    after = lom.safe(lambda: list(track.devices), [])
    new = lom.new_items(baseline.top, after)
    for index in reversed([i for i, device in enumerate(after)
                           if _is_in(new, device) and (only is None or _is_in(only, device))]):
        track.delete_device(index)


def _is_in(items, device):
    return any(item is device for item in items)


def _delete_node(track, nodes, new, node):
    """Delete one device from its chain; if the chain cannot delete, delete the whole top-level
    device, but only when that device is itself new (an existing rack is never removed)."""
    path, _, owner, index = node
    delete = getattr(owner, "delete_device", None)
    if delete is not None:
        delete(index)
        return
    top = next((other for other in nodes if other[0] == path[:1]), None)
    if top is None or not _is_in(new, top[1]):
        raise BatutaError("lom_error", "a blocked device cannot be removed from this chain",
                          {"partial": True})
    track.delete_device(path[0])


def blocked(reasons, verified=True):
    """The not_supported error that reports a cleanup (the call failed after a partial change)."""
    message = "blocked content was removed again" if verified else "new devices were not verified"
    return BatutaError("not_supported", message, {
        "reason": "blocked_content", "partial": True, "removed": reasons, "verified": verified})
