"""Text hygiene helpers: strings that cross the wire are control-stripped and length-capped."""

# C0 and C1 control characters plus the bidirectional override/isolate characters (spec section 0).
_UNSAFE = frozenset(
    [chr(c) for c in range(0x00, 0x20)]
    + [chr(c) for c in range(0x7F, 0xA0)]
    + [chr(c) for c in range(0x202A, 0x202F)]
    + [chr(c) for c in range(0x2066, 0x206A)]
    + [chr(c) for c in range(0xD800, 0xE000)]  # lone surrogates
)


def contains_unsafe(text):
    """True when `text` holds a control or bidi-override character."""
    return any(ch in _UNSAFE for ch in text)


def strip_unsafe(text):
    """Remove control and bidi-override characters."""
    return "".join(ch for ch in text if ch not in _UNSAFE)


def clean(text, max_chars):
    """Control-strip `text` and cut it to `max_chars` code points."""
    return strip_unsafe(str(text))[:max_chars]
