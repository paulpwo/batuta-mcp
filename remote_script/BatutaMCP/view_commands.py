"""Application view commands (view_show, view_focus, view_get).

They only move Live's UI (which panel is visible or focused); the set itself is never written, so
they are non-mutating, never destructive and open no undo step. The client names a view with a
fixed lowercase word; the Live view name comes from the closed table below [A: names as documented
for Live.Application.Application.View.show_view / focus_view / is_view_visible].
"""

from . import validator as v
from .errors import BatutaError
from .registry import Command

# client word -> Live view name (never built from client text)
VIEW_NAMES = {
    "session": "Session",
    "arrangement": "Arranger",
    "detail_clip": "Detail/Clip",
    "detail_device": "Detail/DeviceChain",
    "browser": "Browser",
}
_MAIN_VIEWS = ("session", "arrangement")

VIEW_ARG = v.obj({"view": v.enum(*VIEW_NAMES)}, required=["view"])


def _app_view():
    try:
        import Live
        return Live.Application.get_application().view
    except Exception:  # Live missing or the API differs
        raise BatutaError("not_supported", "the Live application view is not available",
                          {"reason": "live_version"})


def _visible_or_none(view, live_name):
    check = getattr(view, "is_view_visible", None)
    if check is None:
        return None
    return bool(check(live_name))


def _view_show(ctx, args):
    view = _app_view()
    view.show_view(VIEW_NAMES[args["view"]])
    return {"view": args["view"], "visible": _visible_or_none(view, VIEW_NAMES[args["view"]])}


def _view_focus(ctx, args):
    view = _app_view()
    view.focus_view(VIEW_NAMES[args["view"]])
    return {"view": args["view"], "visible": _visible_or_none(view, VIEW_NAMES[args["view"]])}


def _view_get(ctx, args):
    view = _app_view()
    if getattr(view, "is_view_visible", None) is None:
        raise BatutaError("not_supported", "this Live version cannot report the visible views",
                          {"reason": "live_version"})
    visible = {word: bool(view.is_view_visible(live)) for word, live in VIEW_NAMES.items()}
    main = next((word for word in _MAIN_VIEWS if visible[word]), None)
    return {"main": main, "visible": visible}


def install(registry):
    reg = registry.register
    reg(Command("view_show", VIEW_ARG, _view_show))
    reg(Command("view_focus", VIEW_ARG, _view_focus))
    reg(Command("view_get", v.obj({}), _view_get))
