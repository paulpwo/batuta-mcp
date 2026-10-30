"""Numeric limits of the BatutaMCP protocol (docs/01-protocol.md, Appendix A).

Every constant here mirrors one row of the spec so a change is a one-line, reviewable diff.
"""

PROTOCOL_VERSION = 1
SCRIPT_VERSION = "0.2.0"

# Framing and JSON shape.
MAX_FRAME_BYTES = 1_048_576
MAX_JSON_DEPTH = 32
MAX_ARRAY_ITEMS = 10_000
MAX_OBJECT_KEYS = 256
MAX_STRING_BYTES = 4096
MAX_NAME_CHARS = 128
MAX_SAFE_INTEGER = 2 ** 53

# Timeouts in seconds.
HELLO_TIMEOUT_S = 5.0
BODY_TIMEOUT_S = 5.0
IDLE_TIMEOUT_S = 120.0
SEND_TIMEOUT_S = 5.0

# Flow control.
RATE_PER_S = 50
RATE_BURST = 100
MAX_INFLIGHT = 16
QUEUE_MAX = 64
BAD_FRAME_LIMIT = 5
REJECT_THRESHOLD = 500
REJECT_WINDOW_S = 10.0
AUTH_FAILURE_LIMIT = 5
AUTH_FAILURE_WINDOW_S = 60.0
AUTH_LOCKOUT_S = 30.0

# Main-thread execution.
DRAIN_BUDGET_S = 0.020
SEARCH_SLICE_S = 0.015  # one resumable handler (browser_search) runs this long per tick
SEARCH_NODE_CAP = 3000
SWEEP_TICKS = 20  # about 2 s of update_display ticks
MAX_SWEEPS = 4  # pending sweeps in all (and at most one per track)
MAX_RECENT_SWEEPS = 8
DEFAULT_TIMEOUT_MS = 5000
BATCH_TIMEOUT_MS = 10_000
MIN_TIMEOUT_MS = 100
MAX_TIMEOUT_MS = 30_000
MAX_BATCH_OPS = 32

# Misc.
ERROR_MESSAGE_CHARS = 300
URI_MAP_ENTRIES = 5000
SEARCH_MAX_RESULTS = 50
SEARCH_QUERY_MAX = 64
BROWSER_LIST_MAX = 200
BROWSER_PATH_MAX = 8
SOCKET_PATH_MAX_BYTES = 103
EARS_TRACK_NAME = "batuta-ears"
