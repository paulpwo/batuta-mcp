"""Browser content policy (docs/01-protocol.md section 7.10): what may be listed and loaded.

An item is classified from the CATEGORY it was reached from, the SOURCE its URI proves and the
extension of the URI's segments. The display name is used only to ADD blocks (a name that spells
.als, an External device or a plugin extension is blocked whatever the URI says; so are .amxd and Max for
Live names unless `allow_max_for_live` is set)
and, when the URI's last segment has no extension at all, to supply the extension (see below).
Everything is fail closed: an item that cannot be classified is blocked. The result is a `blocked`
reason (or None) in the list result vocabulary: max_for_live, live_set, plugin, external_device,
user_content. `allow_max_for_live` (owner decision 2026-10-30, default on in the server) treats Max for Live
like any other content: .amxd files and the max_for_live category load, a name that spells M4L blocks
nothing. `allow_external_devices` (same decision, default on) does the same for External Audio Effect /
External Instrument; recording with a live external input is then confirmed by the owner (section 5.6).
.als sets, plugins and user presets follow their own rules either way. A folder Live says is not loadable is browsable, so when unclassifiable it reports None.

Assumption A39: the URI marker that proves Core Library content is unknown until it is checked in
Live. `CORE_LIBRARY_URI_PREFIXES` is the one place to set it. While it matches nothing Live emits,
no preset counts as factory and every preset needs `allow_user_presets` (the spec's fallback).
Evidence from Live 12.4.7 (T9 Lite run): items reached through `sounds`, `drums` and `samples` have
opaque URIs without an extension, e.g. `query:Sounds#Bass:FileId_24509` (name `808 Pure.adg`),
`query:Drums#FileId_24756` (`808 Core Kit.adg`), `query:Samples#FileId_41435` (`4 Partials All
Combos.wav`), `query:Drums#Drum%20Rack` (the native device). The same Core Library content reached
through `packs` has a readable path URI, `query:LivePacks#www.ableton.com/0:Racks:Drum%20Racks:...`,
and Pack content `query:LivePacks#www.ableton.com/Operator20:Presets:...`. The `www.ableton.com/0:`
marker only appears in the packs view, which is_core_library never trusts, so it is not applied.
"""

import re

from .textutil import strip_unsafe

CORE_LIBRARY_URI_PREFIXES = ("query:CoreLibrary#",)  # [A39] placeholder, fail closed
CORE_LIBRARY_SOURCES = ("Core Library",)  # [A39] placeholder for BrowserItem.source, fail closed

MAX_CATEGORY = "max_for_live"  # served only with allow_max_for_live, so it is not in CATEGORIES
CATEGORIES = ("instruments", "drums", "sounds", "audio_effects", "midi_effects", "packs",
              "user_library", "samples", "current_project", "plugins")
FACTORY_CATEGORIES = frozenset(["sounds", "drums", "instruments", "audio_effects", "midi_effects"])
NATIVE_DEVICE_CATEGORIES = frozenset(["instruments", "audio_effects", "midi_effects", "drums"])

SAMPLE_EXTENSIONS = frozenset([".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a"])
PRESET_EXTENSIONS = frozenset([".adg", ".adv", ".alc"])
MAX_EXTENSIONS = frozenset([".amxd"])
PLUGIN_EXTENSIONS = frozenset([".vst", ".vst3", ".component", ".aupreset", ".fxp", ".fxb", ".vstpreset"])
EXTERNAL_NAMES = frozenset(["external audio effect", "external instrument"])
PLUGIN_URI_SOURCE = "query:plugins#"

_PERCENT = re.compile(rb"%([0-9A-Fa-f]{2})")
_SEPARATORS = re.compile(r"[:#/]")
_M4L_WORD = re.compile(r"(?:^|[^a-z0-9])m4l(?:[^a-z0-9]|$)")
MAX_DECODE_ROUNDS = 3
MAX_EXTENSION_CHARS = 12


def unquote(text):
    """Percent-decode until stable (at most three rounds), so double encoding cannot hide a suffix."""
    raw = text.encode("utf-8", "surrogatepass")
    for _ in range(MAX_DECODE_ROUNDS):
        decoded = _PERCENT.sub(lambda found: bytes([int(found.group(1), 16)]), raw)
        if decoded == raw:
            break
        raw = decoded
    return strip_unsafe(raw.decode("utf-8", "replace"))


def extension(segment):
    """Lower-case extension of a path segment (with the dot), or '' when it has none."""
    shown = segment.strip()
    dot = shown.rfind(".")
    if dot < 0 or len(shown) - dot > MAX_EXTENSION_CHARS:
        return ""
    return shown[dot:].casefold()


def is_core_library(category, uri, source=None):
    """Factory content, only in the five categories. A readable item source decides by exact comparison
    (so a Pack item with a Core-looking URI is not factory); without one the URI marker is used."""
    if category not in FACTORY_CATEGORIES:
        return False
    if isinstance(source, str) and source:
        return source in CORE_LIBRARY_SOURCES
    return uri.startswith(CORE_LIBRARY_URI_PREFIXES)


def _names_max_for_live(text):
    lowered = text.casefold()
    key = "".join(ch for ch in lowered if ch.isalnum())
    return "maxforlive" in key or "max4live" in key or _M4L_WORD.search(lowered) is not None


def classify(category, uri, is_device, flags, source=None, name=None, is_folder=False):
    """The `blocked` reason for an item reached through `category`, or None when it may be loaded.

    `name` is the display name: it adds blocks and supplies the extension only when the URI's last
    segment has none (Live's FileId URIs). `is_folder` is passed only for a folder Live itself says
    cannot be loaded: its unclassifiable state is None (browsable), a real block still applies."""
    reason = _classify(category, uri, is_device, flags, source, name)
    if is_folder and reason == "user_content":
        return None
    return reason


def _classify(category, uri, is_device, flags, source, name):
    decoded = unquote(uri)
    parts = [part for part in _SEPARATORS.split(decoded) if part]
    if not parts:
        return "user_content"  # no usable URI: unclassifiable
    shown = unquote(name).strip() if isinstance(name, str) else ""
    checked = parts + [shown] if shown else parts
    lowered = [part.casefold() for part in checked]
    if any(".als" in part for part in lowered):
        return "live_set"
    allow_max = flags.get("allow_max_for_live") is True
    if not allow_max:
        if category == MAX_CATEGORY or any(".amxd" in part for part in lowered):
            return "max_for_live"
        if any(_names_max_for_live(part) for part in checked) or (isinstance(source, str)
                                                                  and _names_max_for_live(source)):
            return "max_for_live"
    if not flags.get("allow_external_devices") is True and any(
            " ".join(part.split()).casefold() in EXTERNAL_NAMES for part in checked):
        return "external_device"
    last = extension(parts[-1]) or extension(shown)
    plugin_source = category == "plugins" or decoded.casefold().startswith(PLUGIN_URI_SOURCE)
    if plugin_source or last in PLUGIN_EXTENSIONS:
        return None if flags.get("allow_plugins") is True else "plugin"
    if allow_max and (last in MAX_EXTENSIONS or (category == MAX_CATEGORY and is_device)):
        return None
    if last in SAMPLE_EXTENSIONS:
        return None
    if last in PRESET_EXTENSIONS:
        if is_core_library(category, uri, source) or flags.get("allow_user_presets") is True:
            return None
        return "user_content"
    if is_device and category in NATIVE_DEVICE_CATEGORIES:
        return None
    return "user_content"  # unclassifiable: never served
