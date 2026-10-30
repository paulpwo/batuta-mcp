"""AF_UNIX socket thread (docs/01-protocol.md section 3 and 5.1).

One thread owns every socket. It does accept, framing, authentication, rate limiting, JSON parsing,
envelope and schema validation, and it moves validated jobs to the main thread through a bounded
queue. It never touches the Live Object Model. Responses come back through an outbound queue and a
wake-up socket pair. The thread only ever logs counts and reasons: never frame contents or the token.
"""

import hmac
import queue
import re
import selectors
import socket
import threading
import time
from dataclasses import dataclass

from . import limits
from .dispatcher import Job
from .errors import BatutaError
from .jsonframes import FrameDecoder, FrameError, encode_frame, parse_object
from .ratelimit import AuthLockout, EventWindow, TokenBucket
from .runtime_files import remove_socket, socket_identity

_HELLO_KEYS = frozenset(["type", "protocol", "token", "client", "edition_hint",
                         "allow_plugins", "allow_user_presets", "allow_audio_import", "allow_max_for_live", "allow_external_devices"])
_REQUEST_KEYS = frozenset(["id", "cmd", "args", "timeout_ms", "external_input_ack"])
_EDITION_HINTS = frozenset(["lite", "standard", "suite"])
_RECV_BYTES = 65536
# Backpressure: above the soft cap we stop reading from the client (no new calls) but keep writing;
# the send timeout drops a reader that makes no progress. The hard cap is a last resort: it equals
# the most that max_inflight full-size responses can queue.
_SOFT_OUTBUF_BYTES = 4 * 1024 * 1024
_MAX_OUTBUF_HARD_BYTES = (limits.MAX_INFLIGHT + 1) * limits.MAX_FRAME_BYTES


@dataclass(frozen=True)
class ServerConfig:
    """Spec numbers as defaults; tests shrink them to keep timing tests fast."""

    hello_timeout: float = limits.HELLO_TIMEOUT_S
    body_timeout: float = limits.BODY_TIMEOUT_S
    idle_timeout: float = limits.IDLE_TIMEOUT_S
    send_timeout: float = limits.SEND_TIMEOUT_S
    rate_per_s: float = limits.RATE_PER_S
    burst: int = limits.RATE_BURST
    max_inflight: int = limits.MAX_INFLIGHT
    bad_frame_limit: int = limits.BAD_FRAME_LIMIT
    reject_threshold: int = limits.REJECT_THRESHOLD
    reject_window: float = limits.REJECT_WINDOW_S
    lockout_failures: int = limits.AUTH_FAILURE_LIMIT
    lockout_window: float = limits.AUTH_FAILURE_WINDOW_S
    lockout_duration: float = limits.AUTH_LOCKOUT_S
    tick: float = 0.05


class _Connection:
    def __init__(self, sock, conn_id, now, config, clock):
        self.sock = sock
        self.id = conn_id
        self.decoder = FrameDecoder()
        self.ready = False
        self.closing = False
        self.outbuf = bytearray()
        self.accepted_at = now
        self.last_rx = now
        self.partial_since = None
        self.stalled_since = None
        self.bad_frames = 0
        self.paused = False  # reading suspended by output backpressure
        self.inflight = set()
        self.bucket = TokenBucket(config.rate_per_s, config.burst, clock)
        self.rejections = EventWindow(config.reject_window, clock)
        self.flags = {"allow_plugins": False, "allow_user_presets": False, "allow_audio_import": False,
                      "allow_max_for_live": False, "allow_external_devices": False}


class ConnectionServer:
    def __init__(self, listener, sock_path, token, inbound, registry, welcome_provider, log,
                 clock=time.monotonic, config=None):
        self._listener = listener
        self._sock_path = sock_path
        self._sock_identity = socket_identity(sock_path)  # only unlink the file we bound
        self._token = token
        self._inbound = inbound
        self._registry = registry
        self._welcome_provider = welcome_provider
        self._log = log
        self._clock = clock
        self._config = config or ServerConfig()
        self._outbound = queue.Queue()
        self._lockout = AuthLockout(self._config.lockout_failures, self._config.lockout_window,
                                    self._config.lockout_duration, clock)
        self._selector = None
        self._wake_read, self._wake_write = socket.socketpair()
        self._wake_read.setblocking(False)
        self._wake_write.setblocking(False)
        self._stop = threading.Event()
        self._thread = None
        self._conn = None
        self._next_id = 1
        self.auth_failures = 0

    # ------------------------------------------------------------ main-thread API

    def start(self):
        self._listener.setblocking(False)
        self._selector = selectors.DefaultSelector()
        self._selector.register(self._listener, selectors.EVENT_READ, "listener")
        self._selector.register(self._wake_read, selectors.EVENT_READ, "wake")
        self._thread = threading.Thread(target=self._run, name="BatutaMCP-socket", daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the thread, close every socket and unlink the socket file. Idempotent."""
        self._stop.set()
        self._wake()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=0.5)
        self._close_all()

    @property
    def is_running(self):
        return self._thread is not None and self._thread.is_alive()

    @property
    def current_conn_id(self):
        conn = self._conn
        return conn.id if conn is not None else None

    def is_live(self, conn_id):
        conn = self._conn
        return conn is not None and conn.id == conn_id and conn.ready and not conn.closing

    def post_response(self, conn_id, frame):
        """Called from the main thread; the socket thread writes the frame."""
        self._outbound.put((conn_id, frame))
        self._wake()

    def _wake(self):
        try:
            self._wake_write.send(b"x")
        except (BlockingIOError, OSError):
            pass

    # ------------------------------------------------------------ thread body

    def _run(self):
        try:
            while not self._stop.is_set():
                for key, mask in self._selector.select(timeout=self._config.tick):
                    if key.data == "listener":
                        self._accept()
                    elif key.data == "wake":
                        self._drain_wake()
                    else:
                        self._service(key.data, mask)
                self._drain_outbound()
                self._check_timeouts()
        except Exception as exc:  # the thread must never die silently
            self._log("socket thread stopped: %s: %s" % (type(exc).__name__, exc))
        finally:
            self._close_all()

    def _drain_wake(self):
        try:
            while self._wake_read.recv(4096):
                pass
        except (BlockingIOError, OSError):
            pass

    def _accept(self):
        try:
            sock, _ = self._listener.accept()
        except (BlockingIOError, OSError):
            return
        sock.setblocking(False)
        if self._lockout.is_locked():
            sock.close()  # locked out: close immediately, no reply
            return
        if self._conn is not None:
            self._send_and_close(sock, {"type": "error", "error": {
                "code": "busy", "message": "another client is connected"}})
            return
        now = self._clock()
        conn = _Connection(sock, self._next_id, now, self._config, self._clock)
        self._next_id += 1
        self._conn = conn
        self._selector.register(sock, selectors.EVENT_READ, conn)
        self._log("client connected")

    @staticmethod
    def _send_and_close(sock, frame):
        try:
            sock.send(encode_frame(frame))
        except (OSError, FrameError):
            pass
        sock.close()

    def _service(self, conn, mask):
        if conn is not self._conn:
            return
        if mask & selectors.EVENT_READ and not conn.closing:
            self._on_readable(conn)
        if self._conn is conn and mask & selectors.EVENT_WRITE:
            self._flush(conn)

    # ------------------------------------------------------------ reading

    def _on_readable(self, conn):
        try:
            data = conn.sock.recv(_RECV_BYTES)
        except BlockingIOError:
            return
        except OSError:
            self._close_conn(conn, "read error")
            return
        if not data:
            self._close_conn(conn, "client closed")
            return
        conn.last_rx = self._clock()
        try:
            bodies = conn.decoder.feed(data)
        except FrameError as exc:
            self._fatal(conn, exc.code, exc.message)
            return
        if not conn.decoder.has_partial:
            conn.partial_since = None
        elif conn.partial_since is None:
            conn.partial_since = self._clock()  # the rest of the frame is due within body_timeout
        for body in bodies:
            if self._conn is not conn or conn.closing:
                return
            self._on_frame(conn, body)

    def _on_frame(self, conn, body):
        try:
            frame = parse_object(body)
        except FrameError as exc:
            if not conn.ready:
                self._fatal(conn, "bad_request", exc.message)  # any defect before auth closes (3.2)
            else:
                self._bad_frame(conn, None, exc.message)
            return
        if not conn.ready:
            self._on_hello(conn, frame)
            return
        frame_type = frame.get("type")
        if frame_type == "ping":
            self._queue_frame(conn, {"type": "pong"})
            return
        if frame_type is not None or "cmd" not in frame:
            self._bad_frame(conn, _recover_id(frame), "not a request frame")
            return
        self._on_request(conn, frame)

    # ------------------------------------------------------------ handshake (spec 3.4)

    def _on_hello(self, conn, frame):
        problem = _hello_problem(frame)
        if problem == "protocol":
            self._fatal(conn, "bad_request", "unsupported protocol", {"supported": [limits.PROTOCOL_VERSION]})
            return
        if problem:
            self._fatal(conn, "bad_request", "malformed hello")
            return
        if not self._token_matches(frame["token"]):
            self.auth_failures += 1
            self._lockout.record_failure()
            self._log("authentication failed (%d so far)" % self.auth_failures)
            self._fatal(conn, "auth_failed", "authentication failed")
            return
        conn.flags["allow_plugins"] = frame.get("allow_plugins", False)
        conn.flags["allow_user_presets"] = frame.get("allow_user_presets", False)
        conn.flags["allow_audio_import"] = frame.get("allow_audio_import", False)
        conn.flags["allow_max_for_live"] = frame.get("allow_max_for_live", False)
        conn.flags["allow_external_devices"] = frame.get("allow_external_devices", False)
        conn.ready = True
        self._queue_frame(conn, self._welcome_provider(frame.get("edition_hint")))

    def _token_matches(self, received):
        try:
            candidate = received.encode("ascii")
        except UnicodeEncodeError:
            return False
        if len(candidate) != len(self._token):
            return False
        return hmac.compare_digest(candidate, self._token)

    # ------------------------------------------------------------ calls (spec 3.5, 4)

    def _on_request(self, conn, frame):
        request_id = _recover_id(frame)
        problem = _envelope_problem(frame)
        if problem:
            self._bad_frame(conn, request_id, problem)
            return
        conn.bad_frames = 0
        if request_id in conn.inflight:
            self._reject(conn, request_id, "bad_request", "duplicate request id")
            return
        allowed, retry_ms = conn.bucket.try_take()
        if not allowed:
            self._reject(conn, request_id, "rate_limited", "rate limit exceeded",
                         {"retry_after_ms": retry_ms}, count=True)
            return
        if len(conn.inflight) >= self._config.max_inflight:
            self._reject(conn, request_id, "busy", "too many calls in flight",
                         {"reason": "inflight"}, count=True)
            return
        try:
            command, args = self._registry.prepare_call(frame["cmd"], frame["args"])
        except BatutaError as exc:
            # unknown_command / invalid_args are answered at once, ahead of queued results; the
            # client correlates by id (spec 3.5), and nothing was queued so there is no order to keep.
            self._queue_frame(conn, {"id": request_id, "ok": False, "error": exc.to_wire()})
            return
        timeout_ms = frame.get("timeout_ms", command.default_timeout_ms)
        flags = dict(conn.flags)
        if "external_input_ack" in frame:
            flags["external_input_ack"] = list(frame["external_input_ack"]["tracks"])  # this request only; set by the server, never by a tool
        job = Job(conn.id, request_id, command, args, self._clock() + timeout_ms / 1000.0, flags)
        try:
            self._inbound.put_nowait(job)
        except queue.Full:
            self._reject(conn, request_id, "busy", "call queue is full",
                         {"reason": "queue_full"}, count=True)
            return
        conn.inflight.add(request_id)

    def _reject(self, conn, request_id, code, message, details=None, count=False):
        self._queue_frame(conn, {"id": request_id, "ok": False,
                                 "error": BatutaError(code, message, details).to_wire()})
        if count and conn.rejections.add() > self._config.reject_threshold:
            self._close_conn(conn, "sustained rate violation")

    def _bad_frame(self, conn, request_id, message):
        conn.bad_frames += 1
        allowed, retry_ms = conn.bucket.try_take()  # bad frames cost a token like any call
        if allowed:
            self._queue_frame(conn, {"id": request_id, "ok": False,
                                     "error": BatutaError("bad_request", message).to_wire()})
        else:
            self._reject(conn, request_id, "rate_limited", "rate limit exceeded",
                         {"retry_after_ms": retry_ms}, count=True)
            if self._conn is not conn:
                return
        if conn.bad_frames >= self._config.bad_frame_limit:
            self._close_conn(conn, "too many bad frames")

    def _fatal(self, conn, code, message, details=None):
        """Send one connection-level error and close once it is flushed."""
        conn.closing = True  # set first: _flush closes the connection as soon as the buffer is empty
        self._queue_frame(conn, {"type": "error", "error": BatutaError(code, message, details).to_wire()})

    # ------------------------------------------------------------ writing

    def _queue_frame(self, conn, frame):
        try:
            data = encode_frame(frame)
        except FrameError:
            data = encode_frame(_replacement_error(frame, "too_large", "response exceeds the frame limit"))
        except (TypeError, ValueError):
            data = encode_frame(_replacement_error(frame, "lom_error", "result could not be serialized"))
        conn.outbuf.extend(data)
        self._flush(conn)
        if self._conn is conn and len(conn.outbuf) > _MAX_OUTBUF_HARD_BYTES:
            self._close_conn(conn, "output backlog")

    def _drain_outbound(self):
        while True:
            try:
                conn_id, frame = self._outbound.get_nowait()
            except queue.Empty:
                return
            conn = self._conn
            if conn is None or conn.id != conn_id:
                continue  # response for a connection that no longer exists
            conn.inflight.discard(frame.get("id"))
            self._queue_frame(conn, frame)

    def _flush(self, conn):
        if conn is not self._conn:
            return
        if conn.outbuf:
            try:
                sent = conn.sock.send(conn.outbuf)
            except BlockingIOError:
                sent = 0
            except OSError:
                self._close_conn(conn, "write error")
                return
            if sent:
                del conn.outbuf[:sent]
                conn.stalled_since = None
        if conn.outbuf:
            if conn.stalled_since is None:
                conn.stalled_since = self._clock()
            if len(conn.outbuf) > _SOFT_OUTBUF_BYTES:
                self._pause_reading(conn)
            else:
                self._resume_reading(conn, selectors.EVENT_READ | selectors.EVENT_WRITE)
        else:
            conn.stalled_since = None
            if conn.closing:
                self._close_conn(conn, "closed after reply")
            else:
                self._resume_reading(conn, selectors.EVENT_READ)

    def _pause_reading(self, conn):
        """Backpressure: stop reading; the partial-frame timer is suspended while we do."""
        conn.paused = True
        conn.partial_since = None
        self._set_events(conn, selectors.EVENT_WRITE)

    def _resume_reading(self, conn, events):
        if conn.paused:
            conn.paused = False
            if conn.decoder.has_partial:
                conn.partial_since = self._clock()  # restart the body timer on resume
        self._set_events(conn, events)

    def _set_events(self, conn, events):
        try:
            self._selector.modify(conn.sock, events, conn)
        except (KeyError, ValueError, OSError):
            pass

    # ------------------------------------------------------------ timeouts and teardown

    def _check_timeouts(self):
        conn = self._conn
        if conn is None:
            return
        now = self._clock()
        cfg = self._config
        if not conn.ready and now - conn.accepted_at > cfg.hello_timeout:
            self._close_conn(conn, "hello timeout")
        elif conn.partial_since is not None and now - conn.partial_since > cfg.body_timeout:
            self._close_conn(conn, "frame body timeout")
        elif conn.stalled_since is not None and now - conn.stalled_since > cfg.send_timeout:
            self._close_conn(conn, "send timeout")
        elif now - conn.last_rx > cfg.idle_timeout:
            self._close_conn(conn, "idle timeout")

    def _close_conn(self, conn, reason):
        if self._conn is conn:
            self._conn = None
        try:
            self._selector.unregister(conn.sock)
        except (KeyError, ValueError, OSError):
            pass
        try:
            conn.sock.close()
        except OSError:
            pass
        self._log("client disconnected (%s)" % reason)

    def _close_all(self):
        conn = self._conn
        if conn is not None:
            self._close_conn(conn, "server stopping")
        for sock in (self._listener, self._wake_read, self._wake_write):
            try:
                sock.close()
            except OSError:
                pass
        if self._selector is not None:
            try:
                self._selector.close()
            except OSError:
                pass
            self._selector = None
        remove_socket(self._sock_path, self._sock_identity)


# ---------------------------------------------------------------- pure helpers

def _recover_id(frame):
    value = frame.get("id")
    if type(value) is int and 0 <= value <= limits.MAX_SAFE_INTEGER:
        return value
    return None


def _hello_problem(frame):
    """Return None when the hello is well formed, 'protocol' for a version mismatch, else a text."""
    if frame.get("type") != "hello" or not set(frame) <= _HELLO_KEYS:
        return "shape"
    protocol = frame.get("protocol")
    if type(protocol) is not int or protocol != limits.PROTOCOL_VERSION:
        return "protocol"
    if type(frame.get("token")) is not str:
        return "token"
    client = frame.get("client", "")
    if type(client) is not str or len(client) > 64:
        return "client"
    hint = frame.get("edition_hint")
    if hint is not None and hint not in _EDITION_HINTS:
        return "edition_hint"
    for key in ("allow_plugins", "allow_user_presets", "allow_audio_import", "allow_max_for_live",
                "allow_external_devices"):
        if key in frame and type(frame[key]) is not bool:
            return key
    return None


def _envelope_problem(frame):
    if not set(frame) <= _REQUEST_KEYS:
        return "unknown top-level key"
    request_id = frame.get("id")
    if type(request_id) is not int or not 0 <= request_id <= limits.MAX_SAFE_INTEGER:
        return "id must be an integer between 0 and 2^53"
    if type(frame.get("cmd")) is not str:
        return "cmd must be a string"
    if type(frame.get("args")) is not dict:
        return "args must be an object"
    if "timeout_ms" in frame:
        timeout = frame["timeout_ms"]
        if type(timeout) is not int or not limits.MIN_TIMEOUT_MS <= timeout <= limits.MAX_TIMEOUT_MS:
            return "timeout_ms must be an integer between 100 and 30000"
    if "external_input_ack" in frame and not _valid_ack(frame["external_input_ack"]):
        return "external_input_ack must be an object {tracks: [track ids]}"
    return None


_ACK_ID = re.compile(r"^(t[0-9]{1,4}|r[0-9]{1,4}|m)\Z")


def _valid_ack(ack):
    """The acknowledgement binds a recording to the track ids the owner was shown: {"tracks": ["t1", "m"]}."""
    if type(ack) is not dict or set(ack) != {"tracks"}:
        return False
    tracks = ack["tracks"]
    return type(tracks) is list and len(tracks) <= 256 and all(type(t) is str and _ACK_ID.match(t) for t in tracks)


def _replacement_error(frame, code, message):
    return {"id": frame.get("id"), "ok": False,
            "error": BatutaError(code, message).to_wire()}
