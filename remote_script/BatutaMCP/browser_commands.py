"""Browser tree, search and load (docs/01-protocol.md section 7.10).

Every item the script shows is classified by `browser_policy` and remembered in the per-connection
URI map (LRU, 5000 entries). `browser_load` only loads a URI that this connection listed or found,
classifies it again with the current hello flags, loads onto the selected track (the only target
Live supports, so the target - a regular track, a return or the master - is selected for the call and
the old selection is restored on every path) and then removes any new Max for Live (unless allowed), plugin or External
device (cleanup only).
`browser_search` is a generator the pump resumes each tick (spec 5.1); it never runs inside batch.
"""

import collections

from . import browser_policy, content_policy, limits, lom, sweep
from . import validator as v
from .errors import BatutaError
from .registry import Command
from .textutil import strip_unsafe

MAX_URI_CHARS = 1024
MAX_SOURCE_CHARS = 256
_ROOTS = {
    "instruments": lambda browser: browser.instruments, "drums": lambda browser: browser.drums,
    "sounds": lambda browser: browser.sounds, "audio_effects": lambda browser: browser.audio_effects,
    "midi_effects": lambda browser: browser.midi_effects, "packs": lambda browser: browser.packs,
    "user_library": lambda browser: browser.user_library, "samples": lambda browser: browser.samples,
    "current_project": lambda browser: browser.current_project, "plugins": lambda browser: browser.plugins,
    "max_for_live": lambda browser: browser.max_for_live,
}
_NO_DESCENT = frozenset(["live_set", "max_for_live", "external_device"])


def _refused(reason, message, **details):
    details["reason"] = reason
    return BatutaError("not_supported", message, details)


def get_browser():
    """Live's browser object; a missing Live or browser is a typed refusal."""
    try:
        import Live
        return Live.Application.get_application().browser
    except Exception as exc:  # no Live module, or a Live without a browser
        raise _refused("live_version", "the Live browser is not available",
                       exception=type(exc).__name__) from exc


# ----------------------------------------------------------------- categories and items

def check_category(ctx, category):
    """Served categories only: modulators and anything unnamed are never served; max_for_live only with
    allow_max_for_live."""
    served = category in browser_policy.CATEGORIES or (
        category == browser_policy.MAX_CATEGORY and ctx.flags.get("allow_max_for_live") is True)
    if not served:
        raise _refused("blocked_content", "this browser category is not served")
    if category == "plugins" and ctx.flags.get("allow_plugins") is not True:
        raise _refused("disabled_by_config", "plugins are disabled (browser.allow_plugins)")


def category_root(browser, category):
    try:
        return _ROOTS[category](browser)
    except (AttributeError, RuntimeError) as exc:
        raise _refused("live_version", "this browser category is not available in this Live") from exc


def describe(ctx, category, item):
    """Classify one browser item; the facts are what the URI map keeps for the later load."""
    shown = lom.safe(lambda: item.uri)
    full = strip_unsafe(shown) if isinstance(shown, str) else ""
    too_long = len(full) > MAX_URI_CHARS  # never classified from a truncated copy: blocked, not remembered
    uri = full[:MAX_URI_CHARS]
    is_device = lom.safe(lambda: item.is_device) is True
    raw_loadable = lom.safe(lambda: item.is_loadable) is True
    source = lom.safe(lambda: item.source)
    source = strip_unsafe(source)[:MAX_SOURCE_CHARS] if isinstance(source, str) else None
    name = lom.text(lom.safe(lambda: item.name))
    is_folder = lom.safe(lambda: item.is_folder) is True
    blocked = "user_content" if too_long else browser_policy.classify(category, uri, is_device, ctx.flags,
                                                                      source, name,
                                                                      is_folder and not raw_loadable)
    return {
        "category": category, "name": name, "uri": uri, "item": item,
        "too_long": too_long, "source": source,
        "is_device": is_device, "raw_loadable": raw_loadable, "blocked": blocked,
        "loadable": raw_loadable and blocked is None,
        "is_folder": is_folder,
    }


def remember(ctx, entry):
    if entry["uri"] and not entry["too_long"]:
        ctx.state.remember_uri(entry["uri"], entry)


def take_children(item, limit):
    """([first `limit` children], more) read lazily: `iter_children` when Live has it (a method or an
    iterable), else `children` iterated with the same cap. One extra child is read to learn `more`."""
    found = []
    try:
        reader = getattr(item, "iter_children", None)
        source = (reader() if callable(reader) else reader) if reader is not None else item.children
        for child in source:
            if len(found) >= limit:
                return found, True
            found.append(child)
    except (AttributeError, RuntimeError):
        pass  # an item that cannot list its children has none
    return found, False


# ----------------------------------------------------------------- browser_list

def _navigate(root, path):
    node = root
    for hop, name in enumerate(path):
        children, _ = take_children(node, limits.SEARCH_NODE_CAP)
        matches = [child for child in children if lom.text(lom.safe(lambda: child.name)) == name]
        if not matches:
            raise lom.not_found("browser_item", hop, "path_not_found")
        if len(matches) > 1:
            raise lom.invalid("ambiguous_name", "several items share this name", candidates=[
                {"index": position, "name": name} for position in range(min(len(matches), 10))])
        node = matches[0]
    return node


def _browser_list(ctx, args):
    category = args["category"]
    check_category(ctx, category)
    node = _navigate(category_root(get_browser(), category), args.get("path", []))
    start = args["offset"]
    stop = start + args["limit"]
    # Read at most the budget (or the page end, if deeper): a huge folder is never built for `total`.
    children, more = take_children(node, max(limits.SEARCH_NODE_CAP, stop))
    items = []
    for item in children[start:stop]:
        entry = describe(ctx, category, item)
        remember(ctx, entry)
        items.append({"name": entry["name"], "uri": entry["uri"], "is_folder": entry["is_folder"],
                      "is_loadable": entry["loadable"], "is_device": entry["is_device"],
                      "blocked": entry["blocked"]})
    return {"items": items, "total": len(children), "total_capped": more,
            "next_offset": stop if (more or stop < len(children)) else None}


# ----------------------------------------------------------------- browser_search

def _search_check(ctx, args):
    if "category" in args:
        check_category(ctx, args["category"])


def _search_categories(ctx, args):
    if "category" in args:
        return [args["category"]]
    names = [name for name in browser_policy.CATEGORIES
             if name != "plugins" or ctx.flags.get("allow_plugins") is True]
    if ctx.flags.get("allow_max_for_live") is True:
        names.append(browser_policy.MAX_CATEGORY)
    return names


def _browser_search(ctx, args):
    """Breadth-first over the served categories, yielding after every node so the pump can slice it."""
    browser = get_browser()
    query = args["query"].casefold()
    queue = collections.deque()
    cap = limits.SEARCH_NODE_CAP
    overflow = False
    for category in _search_categories(ctx, args):
        try:
            root = category_root(browser, category)
        except BatutaError:
            if "category" in args:
                raise
            continue  # an omitted category filter skips what this Live lacks
        children, more = take_children(root, max(0, cap - len(queue)))
        queue.extend((category, child, []) for child in children)
        overflow = overflow or more
        yield
    results = []
    visited = 0
    truncated = False
    while queue:
        if visited >= cap:
            truncated = True
            break
        category, item, parents = queue.popleft()
        visited += 1
        entry = describe(ctx, category, item)
        path = parents + [entry["name"]]
        if query in entry["name"].casefold() and (entry["loadable"] or not args["loadable_only"]):
            remember(ctx, entry)
            results.append({"name": entry["name"], "uri": entry["uri"], "path": path,
                            "is_loadable": entry["loadable"], "blocked": entry["blocked"]})
            if len(results) >= args["limit"]:
                truncated = bool(queue) or overflow
                break
        if entry["is_folder"] and entry["blocked"] not in _NO_DESCENT:
            # nothing past the node budget will ever be visited, so nothing past it is read
            children, more = take_children(item, max(0, cap - visited - len(queue)))
            queue.extend((category, child, path) for child in children)
            overflow = overflow or more
        yield
    truncated = truncated or overflow
    return {"items": results, "truncated": truncated, "visited": visited}


# ----------------------------------------------------------------- browser_load

def _load_check(ctx, args):
    """-> (track, entry, baseline). The URI must be known to this connection and still pass the
    policy, and the track's device tree must be fully visible (else nothing new could be verified)."""
    track = lom.resolve_track(ctx.song, args["track"])
    sweeps = ctx.state.sweeps
    if len(sweeps) >= limits.MAX_SWEEPS or any(lom.same(pending.track, track) for pending in sweeps):
        raise BatutaError("busy", "an earlier load on this track or too many loads are still being swept",
                          {"reason": "sweep_pending"})
    entry = ctx.state.lookup_uri(args["uri"])
    if entry is None:
        raise _refused("blocked_content", "this URI was not listed by this connection",
                       blocked="unlisted_uri")
    blocked = browser_policy.classify(entry["category"], entry["uri"], entry["is_device"], ctx.flags,
                                      entry["source"], entry["name"],
                                      entry["is_folder"] and not entry["raw_loadable"])
    if blocked is None and not entry["raw_loadable"]:
        blocked = "not_loadable"
    if blocked is not None:
        raise _refused("blocked_content", "this item cannot be loaded", blocked=blocked)
    if ctx.flags.get("allow_external_devices") is True and browser_policy.classify(
            entry["category"], entry["uri"], entry["is_device"], dict(ctx.flags, allow_external_devices=False),
            entry["source"], entry["name"], entry["is_folder"] and not entry["raw_loadable"]) == "external_device":
        ctx.recording.check_external_insert(track, "browser_load")  # asks while a recording is possible
    baseline = content_policy.snapshot(track)
    content_policy.require_visible(baseline)
    return track, entry, baseline


def _verify_load(song, track, before, tracks_before, allow_plugins, allow_max=False, allow_external=False):
    """After load_item: clean the target track and any track Live created. -> (reasons, verified, landed, report).

    `report` holds new_tracks/landed_on when Live created tracks (it never removes or disarms them).

    `landed` is False when nothing changed at all, which means load_item may be asynchronous (A23)."""
    created = lom.new_items(tracks_before, lom.safe(lambda: list(song.tracks), []))
    landed = bool(created) or content_policy.changed(before, content_policy.Baseline(track))
    reasons, verified = content_policy.purge_new_devices(track, before, allow_plugins, allow_max=allow_max,
                                                       allow_external=allow_external)
    report = lom.created_tracks_report(song, created)
    for fresh in created:
        found, ok = content_policy.purge_new_devices(fresh, content_policy.Baseline(None), allow_plugins,
                                                       allow_max=allow_max, allow_external=allow_external)
        reasons += found
        verified = verified and ok
    return reasons, verified, landed, report


def _browser_load(ctx, args):
    track, entry, before = _load_check(ctx, args)
    browser = get_browser()
    song = ctx.song
    view = song.view
    previous = view.selected_track
    tracks_before = lom.safe(lambda: list(song.tracks), [])
    allow_plugins = ctx.flags.get("allow_plugins") is True
    allow_max = ctx.flags.get("allow_max_for_live") is True
    # An External device that was not announced (its name hid it) is removed while a recording could capture it.
    allow_external = ctx.flags.get("allow_external_devices") is True and ctx.recording.external_allowed_on(track)
    ctx.note_mutation()
    try:
        view.selected_track = track
        if not lom.same(view.selected_track, track):  # Live kept another selection: the load would land there
            raise _refused("selection_failed", "the target track could not be selected, so nothing was loaded")
        browser.load_item(entry["item"])
        reasons, verified, landed, report = _verify_load(song, track, before, tracks_before, allow_plugins,
                                                         allow_max, allow_external)
    finally:
        if previous is not None and not lom.same(view.selected_track, previous):
            view.selected_track = previous
    if reasons or not verified:
        raise content_policy.blocked(reasons, verified)
    if not landed:
        # An asynchronous load may land after the selection went back, i.e. on the previous track.
        also = None
        if previous is not None and not lom.same(previous, track):
            watched = content_policy.snapshot(previous)
            if not watched.truncated:
                also = (previous, watched)
        ctx.state.add_sweep(sweep.Sweep(track, before, tracks_before, allow_plugins, also, allow_max, allow_external))
    result = {"loaded": {"name": entry["name"], "uri": entry["uri"]},
              "device_count": len(lom.safe(lambda: list(track.devices), [])),
              "verified": landed, "sweep_pending": not landed, "previous_sweep": ctx.state.take_sweep()}
    result.update(report)
    return result


# ----------------------------------------------------------------- registration

def install(registry):
    reg = registry.register
    name = v.string(max_chars=limits.MAX_NAME_CHARS)
    category = v.string(max_chars=64)
    reg(Command("browser_list", v.obj({
        "category": category, "path": v.array(name, max_items=limits.BROWSER_PATH_MAX),
        "limit": v.with_default(v.integer(min=1, max=limits.BROWSER_LIST_MAX), 100),
        "offset": v.with_default(v.integer(min=0), 0)}, required=["category"]), _browser_list))
    reg(Command("browser_search", v.obj({
        "query": v.string(max_chars=limits.SEARCH_QUERY_MAX, min_chars=1), "category": category,
        "loadable_only": v.with_default(v.boolean(), True),
        "limit": v.with_default(v.integer(min=1, max=limits.SEARCH_MAX_RESULTS), 25)},
        required=["query"]), _browser_search, resumable=True, precheck=_search_check,
        default_timeout_ms=15000))
    reg(Command("browser_load", v.obj({"track": v.TRACK_REF, "uri": v.string(max_chars=MAX_URI_CHARS)},
                                      required=["track", "uri"]), _browser_load, mutating=True,
                precheck=_load_check))
