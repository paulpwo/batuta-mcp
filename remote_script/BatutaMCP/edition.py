"""Edition limits and prechecks (docs/01-protocol.md section 8)."""

from .errors import BatutaError

EDITIONS = ("lite", "standard", "suite", "unknown")
RESOURCES = ("tracks", "scenes", "returns")

_LIMITS = {
    "lite": {"tracks": 8, "scenes": 16, "returns": 2},
    "standard": {"tracks": None, "scenes": None, "returns": 12},
    "suite": {"tracks": None, "scenes": None, "returns": 12},
    "unknown": {"tracks": None, "scenes": None, "returns": None},
}
_LIMIT_WORDS = ("limit", "maximum", "lite")


def limit_for(edition, resource):
    """Maximum count of `resource` in `edition`, or None when unlimited or unknown."""
    return _LIMITS.get(edition, _LIMITS["unknown"])[resource]


def detect_edition(version_string):
    """Only Lite is detectable from the version string (assumption A3); everything else is unknown."""
    if isinstance(version_string, str) and "lite" in version_string.lower():
        return "lite"
    return "unknown"


def resolve_edition(detected, hint):
    """Detection wins over the client hint; returns (edition, source)."""
    if detected in ("lite", "standard", "suite"):
        return detected, "detected"
    if hint in ("lite", "standard", "suite"):
        return hint, "hint"
    return "unknown", "none"


def looks_like_limit_error(text):
    lowered = str(text).lower()
    return any(word in lowered for word in _LIMIT_WORDS)


class EditionPolicy:
    """Pure precheck: compares counts with the edition limits and raises edition_limit."""

    def __init__(self, edition):
        self.edition = edition

    def check(self, resource, current, adding=1, op_index=None):
        limit = limit_for(self.edition, resource)
        if limit is None or current + adding <= limit:
            return
        details = {"resource": resource, "limit": limit, "current": current,
                   "edition": self.edition}
        if op_index is not None:
            details["op_index"] = op_index
        raise BatutaError("edition_limit",
                          "%s limit of %s edition (%d) would be exceeded" % (resource, self.edition, limit),
                          details)

    def check_projection(self, counts, deltas):
        """Walk `deltas` (one dict or None per batch op) over a copy of `counts`.

        Counts are updated op by op, so earlier creations and deletions are taken into account.
        Raises edition_limit with `op_index` at the first op that would exceed a limit.
        """
        running = {name: counts.get(name, 0) for name in RESOURCES}
        for index, delta in enumerate(deltas):
            for resource, change in (delta or {}).items():
                if change > 0:
                    self.check(resource, running[resource], adding=change, op_index=index)
                running[resource] += change
