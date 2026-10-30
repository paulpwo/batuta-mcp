"""Length-prefixed JSON framing and strict JSON parsing (docs/01-protocol.md section 3.1).

A frame is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON (one object).
All parsing limits are enforced here so that nothing hostile reaches the schema validators.
"""

import json
import math
import struct

from . import limits

_HEADER = struct.Struct(">I")


class FrameError(Exception):
    """A framing or parsing defect; `code` is a protocol error code (bad_request or too_large)."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class FrameDecoder:
    """Incremental decoder: feed raw bytes, receive complete frame bodies."""

    def __init__(self):
        self._buffer = bytearray()
        self._need = None  # body length once the header is known

    @property
    def has_partial(self):
        """True while a frame is half received (used for the body timeout)."""
        return bool(self._buffer) or self._need is not None

    def feed(self, data):
        self._buffer.extend(data)
        bodies = []
        while True:
            if self._need is None:
                if len(self._buffer) < _HEADER.size:
                    break
                (length,) = _HEADER.unpack_from(self._buffer, 0)
                # Reject by header alone: the body is never read for a bad length.
                if length == 0:
                    raise FrameError("bad_request", "empty frame")
                if length > limits.MAX_FRAME_BYTES:
                    raise FrameError("too_large", "frame exceeds %d bytes" % limits.MAX_FRAME_BYTES)
                del self._buffer[:_HEADER.size]
                self._need = length
            if len(self._buffer) < self._need:
                break
            bodies.append(bytes(self._buffer[:self._need]))
            del self._buffer[:self._need]
            self._need = None
        return bodies


def encode_frame(obj):
    """Serialize `obj` into one frame; raises FrameError(too_large) or ValueError (NaN, bad types)."""
    body = json.dumps(obj, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
    if len(body) > limits.MAX_FRAME_BYTES:
        raise FrameError("too_large", "response exceeds %d bytes" % limits.MAX_FRAME_BYTES)
    return _HEADER.pack(len(body)) + body


def _check_depth(body):
    """Linear scan that counts brackets outside strings, so deep input never reaches json.loads."""
    depth = 0
    in_string = False
    escaped = False
    for byte in body:
        if in_string:
            if escaped:
                escaped = False
            elif byte == 0x5C:  # backslash
                escaped = True
            elif byte == 0x22:  # closing quote
                in_string = False
        elif byte == 0x22:
            in_string = True
        elif byte == 0x5B or byte == 0x7B:  # [ {
            depth += 1
            if depth > limits.MAX_JSON_DEPTH:
                raise FrameError("bad_request", "JSON nesting deeper than %d" % limits.MAX_JSON_DEPTH)
        elif byte == 0x5D or byte == 0x7D:  # ] }
            depth -= 1


def _parse_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return value


def _parse_int(text):
    value = int(text)
    if abs(value) > limits.MAX_SAFE_INTEGER:
        raise ValueError("integer beyond 2^53")
    return value


def _reject_constant(name):
    raise ValueError("constant %s is not allowed" % name)


def _pairs_hook(pairs):
    if len(pairs) > limits.MAX_OBJECT_KEYS:
        raise ValueError("too many keys")
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        if len(key.encode("utf-8", "surrogatepass")) > limits.MAX_STRING_BYTES:
            raise ValueError("key too long")
        result[key] = value
    return result


def _check_shape(root):
    """Iteratively enforce array and string caps (depth is already bounded)."""
    stack = [root]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            stack.extend(node.values())
        elif isinstance(node, list):
            if len(node) > limits.MAX_ARRAY_ITEMS:
                raise ValueError("array too long")
            stack.extend(node)
        elif isinstance(node, str):
            if len(node.encode("utf-8", "surrogatepass")) > limits.MAX_STRING_BYTES:
                raise ValueError("string too long")


def parse_object(body):
    """Parse a frame body into a dict under the strict rules of spec section 3.1."""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        raise FrameError("bad_request", "frame is not valid UTF-8") from None
    _check_depth(body)
    try:
        value = json.loads(text, object_pairs_hook=_pairs_hook, parse_float=_parse_float,
                           parse_int=_parse_int, parse_constant=_reject_constant)
        if not isinstance(value, dict):
            raise ValueError("top-level value must be an object")
        _check_shape(value)
    except (ValueError, RecursionError):
        raise FrameError("bad_request", "frame is not acceptable JSON") from None
    return value
