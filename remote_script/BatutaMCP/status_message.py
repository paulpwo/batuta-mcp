"""Status bar feedback line (docs/01-protocol.md, "Status bar feedback").

The line is built only from the registered command name, integers, floats, booleans and enum
keywords the command schema already validated. Names, URIs, paths, notes and any other free text
from the arguments are never read into it. The line is for a person looking at Live, so indices are
shown as Live numbers them: tracks, slots, scenes and devices from 1, returns as letters (A, B, ...).
"""

import math

PREFIX = "BatutaMCP: "
MAX_CHARS = 120
MAX_PAIRS = 3
_TRACK_KINDS = ("track", "return", "master")
_REF_KEYS = frozenset(["track", "clip", "slot", "scene", "device", "track_index", "scene_index",
                       "device_index", "slot_index"])


def _is_int(value):
    return type(value) is int


def _number_text(value):
    if type(value) is bool:
        return "true" if value else "false"
    if _is_int(value):
        return str(value)
    if type(value) is float and math.isfinite(value):
        return ("%.2f" % value).rstrip("0").rstrip(".")
    return None


def _track_text(ref):
    if not isinstance(ref, dict):
        return None
    kind = ref.get("kind")
    if kind == "master":
        return "master"
    if kind == "return" and _is_int(ref.get("index")) and 0 <= ref["index"] < 26:
        return "return %s" % chr(ord("A") + ref["index"])
    if kind in _TRACK_KINDS and _is_int(ref.get("index")):
        return "%s %d" % (kind, ref["index"] + 1)
    return None


def _enum_values(node):
    if not isinstance(node, dict):
        return ()
    if node.get("type") == "enum":
        return tuple(node["values"])
    if node.get("type") == "one_of":
        found = []
        for branch in node["schemas"]:
            found.extend(_enum_values(branch))
        return tuple(found)
    return ()


def _ref_parts(args):
    parts = []
    track = _track_text(args.get("track"))
    if track is None and _is_int(args.get("track_index")):
        track = "track %d" % (args["track_index"] + 1)
    clip = args.get("clip")
    if isinstance(clip, dict):
        track = _track_text(clip.get("track")) or track
    if track:
        parts.append(track)
    slot = args.get("slot")
    if isinstance(clip, dict) and clip.get("kind") == "session":
        slot = clip.get("slot")
    elif isinstance(slot, dict):
        track = _track_text(slot.get("track"))
        if track and track not in parts:
            parts.insert(0, track)
        slot = slot.get("slot")
    if _is_int(slot):
        parts.append("slot %d" % (slot + 1))
    for key, label in (("scene", "scene"), ("scene_index", "scene"), ("device", "device"),
                       ("device_index", "device")):
        if _is_int(args.get(key)):
            parts.append("%s %d" % (label, args[key] + 1))
    return parts


def _pair_parts(command, args):
    props = command.schema.get("props", {}) if command.schema.get("type") == "object" else {}
    pairs = []
    for key, value in args.items():
        if len(pairs) >= MAX_PAIRS:
            break
        if key in _REF_KEYS or key not in props:
            continue
        if isinstance(value, str):
            if value in _enum_values(props[key]):
                pairs.append("%s=%s" % (key, value))
            continue
        text = _number_text(value)
        if text is not None:
            pairs.append("%s=%s" % (key, text))
    return pairs


def _finish(text):
    text = " ".join(text.split())
    text = text.encode("ascii", "ignore").decode("ascii")
    return text[:MAX_CHARS].rstrip()


def success_line(command, args):
    """The line after a mutating command completed."""
    if command.name == "batch":
        return _finish("%sbatch (%d ops)" % (PREFIX, len(args["ops"])))
    parts = [command.name] + _ref_parts(args) + _pair_parts(command, args)
    return _finish(PREFIX + " ".join(parts))


def refusal_line(command, error):
    """The line after a mutating command was refused or failed."""
    return _finish("%s%s refused (%s)" % (PREFIX, command.name, error.code))
