"""Declarative schema validator for command arguments (docs/01-protocol.md section 5.2).

Schemas are plain dicts built with the helper functions below. Validation is strict: unknown keys
are errors, booleans are never numbers, floats are never integers, and strings may not carry
control or bidi characters. Nothing here looks at client data through dynamic attribute access.
"""

import copy
import math
import re

from . import limits
from .errors import BatutaError
from .textutil import contains_unsafe

_MISSING = object()


# ----------------------------------------------------------------- schema builders

def integer(min=None, max=None):
    return {"type": "int", "min": min, "max": max}


def number(min=None, max=None, exclusive_min=False):
    return {"type": "number", "min": min, "max": max, "exclusive_min": exclusive_min}


def boolean():
    return {"type": "bool"}


def string(max_chars=None, max_bytes=limits.MAX_STRING_BYTES, pattern=None, min_chars=0):
    return {"type": "string", "max_chars": max_chars, "max_bytes": max_bytes,
            "pattern": re.compile(pattern) if pattern else None, "min_chars": min_chars}


def enum(*values):
    return {"type": "enum", "values": tuple(values)}


def array(items, min_items=0, max_items=limits.MAX_ARRAY_ITEMS):
    return {"type": "array", "items": items, "min": min_items, "max": max_items}


def obj(props, required=(), at_least_one=False, exclusive=()):
    return {"type": "object", "props": dict(props), "required": tuple(required),
            "at_least_one": at_least_one, "exclusive": tuple(tuple(pair) for pair in exclusive)}


def free_object():
    """Any JSON object (its content is validated later, e.g. batch op args)."""
    return {"type": "free_object"}


def one_of(*schemas):
    return {"type": "one_of", "schemas": tuple(schemas)}


def nullable(schema):
    result = dict(schema)
    result["nullable"] = True
    return result


def with_default(schema, value):
    result = dict(schema)
    result["default"] = value
    return result


# ----------------------------------------------------------------- common shapes (spec 6.1, 6.3)

TRACK_REF = one_of(
    obj({"kind": enum("track", "return"), "index": integer(min=0),
         "expect_name": string(max_chars=limits.MAX_NAME_CHARS)},
        required=["kind", "index"]),
    obj({"kind": enum("master"), "expect_name": string(max_chars=limits.MAX_NAME_CHARS)},
        required=["kind"]),
)

PAGING_PROPS = {
    "limit": with_default(integer(min=1, max=500), 100),
    "offset": with_default(integer(min=0), 0),
}


# ----------------------------------------------------------------- validation

def _fail(path, reason, **extra):
    details = {"path": path, "reason": reason}
    details.update(extra)
    return BatutaError("invalid_args", "invalid argument at %s: %s" % (path, reason), details)


def validate(schema, value, path="args"):
    """Return the normalized value (defaults filled in) or raise BatutaError(invalid_args)."""
    if value is None and schema.get("nullable"):
        return None
    kind = schema["type"]
    if kind == "int":
        return _check_int(schema, value, path)
    if kind == "number":
        return _check_number(schema, value, path)
    if kind == "bool":
        if type(value) is not bool:
            raise _fail(path, "expected boolean")
        return value
    if kind == "string":
        return _check_string(schema, value, path)
    if kind == "enum":
        # bool is an int in Python: compare types too so True never matches 1.
        for allowed in schema["values"]:
            if type(value) is type(allowed) and value == allowed:
                return value
        raise _fail(path, "not one of the allowed values")
    if kind == "array":
        return _check_array(schema, value, path)
    if kind == "object":
        return _check_object(schema, value, path)
    if kind == "free_object":
        if type(value) is not dict:
            raise _fail(path, "expected object")
        return value
    if kind == "one_of":
        return _check_one_of(schema, value, path)
    raise ValueError("unknown schema type %r" % (kind,))  # a programming error, not client data


def _check_int(schema, value, path):
    if type(value) is not int:
        raise _fail(path, "expected integer")
    _check_range(schema, value, path)
    return value


def _check_number(schema, value, path):
    if type(value) not in (int, float):
        raise _fail(path, "expected number")
    if isinstance(value, float) and not math.isfinite(value):
        raise _fail(path, "number must be finite")
    _check_range(schema, value, path)
    return value


def _check_range(schema, value, path):
    low, high = schema.get("min"), schema.get("max")
    if low is not None:
        if schema.get("exclusive_min"):
            if value <= low:
                raise _fail(path, "must be greater than %s" % low)
        elif value < low:
            raise _fail(path, "must be at least %s" % low)
    if high is not None and value > high:
        raise _fail(path, "must be at most %s" % high)


def _check_string(schema, value, path):
    if type(value) is not str:
        raise _fail(path, "expected string")
    if contains_unsafe(value):
        raise _fail(path, "control or bidi characters are not allowed")
    if len(value) < schema["min_chars"]:
        raise _fail(path, "too short")
    if schema["max_chars"] is not None and len(value) > schema["max_chars"]:
        raise _fail(path, "longer than %d characters" % schema["max_chars"])
    if len(value.encode("utf-8", "surrogatepass")) > schema["max_bytes"]:
        raise _fail(path, "longer than %d bytes" % schema["max_bytes"])
    if schema["pattern"] is not None and not schema["pattern"].search(value):
        raise _fail(path, "does not match the required pattern")
    return value


def _check_array(schema, value, path):
    if type(value) is not list:
        raise _fail(path, "expected array")
    if len(value) < schema["min"]:
        raise _fail(path, "needs at least %d items" % schema["min"])
    if len(value) > schema["max"]:
        raise _fail(path, "has more than %d items" % schema["max"])
    return [validate(schema["items"], item, "%s[%d]" % (path, index))
            for index, item in enumerate(value)]


def _check_object(schema, value, path):
    if type(value) is not dict:
        raise _fail(path, "expected object")
    props = schema["props"]
    for key in value:
        if key not in props:
            raise _fail("%s.%s" % (path, key), "unknown_key")
    for key in schema["required"]:
        if key not in value:
            raise _fail("%s.%s" % (path, key), "missing")
    if schema["at_least_one"] and not value:
        raise _fail(path, "at_least_one")
    for first, second in schema["exclusive"]:
        if first in value and second in value:
            raise _fail(path, "mutually_exclusive", fields=[first, second])
    result = {}
    for key, sub in props.items():
        if key in value:
            result[key] = validate(sub, value[key], "%s.%s" % (path, key))
        elif "default" in sub:
            result[key] = copy.deepcopy(sub["default"])
    return result


def _check_one_of(schema, value, path):
    last = None
    for candidate in schema["schemas"]:
        try:
            return validate(candidate, value, path)
        except BatutaError as exc:
            last = exc
    raise last
