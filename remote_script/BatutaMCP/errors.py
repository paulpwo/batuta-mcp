"""Typed errors of the wire protocol (docs/01-protocol.md section 4)."""

from . import limits
from .textutil import clean

ERROR_CODES = frozenset([
    "bad_request", "unknown_command", "invalid_args", "not_found", "out_of_range",
    "edition_limit", "lom_error", "timeout", "busy", "auth_failed", "too_large",
    "rate_limited", "not_supported", "cleanup_failed",
])

# Words in a Live exception that suggest an edition limit was hit (spec section 8, assumption A4).
_LIMIT_HINTS = ("limit", "maximum", "lite")


class BatutaError(Exception):
    """An error that maps one-to-one onto a protocol error object."""

    def __init__(self, code, message, details=None):
        if code not in ERROR_CODES:
            raise ValueError("unknown error code %r" % (code,))
        super().__init__(message)
        self.code = code
        self.message = clean(message, limits.ERROR_MESSAGE_CHARS)
        self.details = details

    def to_wire(self):
        wire = {"code": self.code, "message": self.message}
        if self.details:
            wire["details"] = self.details
        return wire


def from_exception(exc, partial=False, edition_unknown=False):
    """Map any exception raised by a handler to a BatutaError (never leaks a traceback)."""
    if isinstance(exc, BatutaError):
        return exc
    text = str(exc) or type(exc).__name__
    details = {"exception": type(exc).__name__, "partial": bool(partial)}
    if edition_unknown and any(hint in text.lower() for hint in _LIMIT_HINTS):
        details["suspected"] = "edition_limit"
    return BatutaError("lom_error", text, details)
