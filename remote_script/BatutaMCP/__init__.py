"""BatutaMCP Remote Script for Ableton Live 12 (docs/01-protocol.md).

`create_instance(c_instance)` returns a plain object with the methods Live calls on a control
surface. It does not use Live's private control-surface framework: only the standard library and
the runtime `Live` module are used. All Live Object Model access happens in `update_display`,
which Live calls on its main thread; the socket thread only moves bytes and validated calls.
"""

import queue
import re
import threading

from . import edition as edition_module
from . import limits
from .command_set import build_registry
from .dispatcher import Dispatcher, MainThreadPump
from .runtime_files import (RuntimeFileError, remove_socket, socket_identity, check_socket_path_length, default_runtime_dir,
                            ensure_runtime_dir, load_or_create_token, prepare_listener,
                            SCRIPT_VERSION, SOCKET_NAME)
from .server import ConnectionServer, ServerConfig
from .state import ScriptState

_VERSION_NUMBER = re.compile(r"\d+(?:\.\d+)+")


def create_instance(c_instance):
    """Entry point called by Live when the script is selected in Preferences."""
    return BatutaScript(c_instance)


class BatutaScript:
    """Plain control-surface object (assumption A1: Live accepts it without a base class)."""

    def __init__(self, c_instance, runtime_dir=None, server_config=None):
        self._c_instance = c_instance
        self._main_thread = threading.get_ident()
        self._pending_logs = queue.SimpleQueue()
        self._token_text = None
        self._server = None
        self._pump = None
        self._sock_path = None
        self.state = ScriptState()
        self._live_version, self._detected_edition = self._read_live_info()
        self._start(runtime_dir or default_runtime_dir(), server_config or ServerConfig())

    # ------------------------------------------------------------ startup

    def _start(self, runtime_dir, server_config):
        """Never raises: any failure is logged once and the script simply does not listen."""
        listener = None
        server = None
        try:
            ensure_runtime_dir(runtime_dir)
            sock_path = runtime_dir.rstrip("/") + "/" + SOCKET_NAME
            check_socket_path_length(sock_path)
            token = load_or_create_token(runtime_dir)
            listener = prepare_listener(sock_path)
            identity = socket_identity(sock_path)
            inbound = queue.Queue(maxsize=limits.QUEUE_MAX)
            registry = build_registry()
            server = ConnectionServer(listener, sock_path, token, inbound, registry,
                                      self._welcome, self._queue_log, config=server_config)
            dispatcher = Dispatcher(registry, self._c_instance, self.state, log=self._log)
            pump = MainThreadPump(inbound, dispatcher, server.post_response, server.is_live)
            server.start()
        except Exception as exc:  # RuntimeFileError or anything unexpected
            if server is not None:
                server.stop()
            elif listener is not None:
                listener.close()
                remove_socket(sock_path, identity)
            self._log("refusing to listen: %s" % (exc if isinstance(exc, RuntimeFileError)
                                                  else "%s: %s" % (type(exc).__name__, exc)))
            return
        self._token_text = token.decode("ascii")
        self._server = server
        self._pump = pump
        self._log("listening")

    def _read_live_info(self):
        """Version and edition detection on the main thread (assumption A3)."""
        try:
            import Live
            text = Live.Application.get_application().get_version_string()
        except Exception:  # Live missing or API different: stay unknown rather than fail to load
            return "unknown", "unknown"
        found = _VERSION_NUMBER.search(text) if isinstance(text, str) else None
        version = found.group(0) if found else "unknown"
        return version, edition_module.detect_edition(text)

    def _welcome(self, hint):
        """Runs on the socket thread: builds the welcome frame and records the edition."""
        edition, source = edition_module.resolve_edition(self._detected_edition, hint)
        self.state.set_edition(edition, source)
        return {
            "type": "welcome", "protocol": limits.PROTOCOL_VERSION,
            "live_version": self._live_version, "script_version": SCRIPT_VERSION,
            "edition": edition, "edition_source": source,
            "max_frame": limits.MAX_FRAME_BYTES,
            "limits": {"max_inflight": limits.MAX_INFLIGHT, "rate_per_s": limits.RATE_PER_S,
                       "burst": limits.RATE_BURST},
        }

    # ------------------------------------------------------------ logging

    def _log(self, message):
        """Log through Live from the main thread; the token is scrubbed, a failing logger ignored."""
        text = str(message)
        if self._token_text:
            text = text.replace(self._token_text, "<redacted>")
        try:
            self._c_instance.log_message("BatutaMCP: " + text)
        except Exception:
            pass

    def _queue_log(self, message):
        """Entry point for the socket thread: c_instance is only touched from the main thread."""
        if threading.get_ident() == self._main_thread:
            self._log(message)
        else:
            self._pending_logs.put(str(message))

    def _flush_logs(self):
        while True:
            try:
                message = self._pending_logs.get_nowait()
            except queue.Empty:
                return
            self._log(message)

    @property
    def is_listening(self):
        return self._server is not None and self._server.is_running

    # ------------------------------------------------------------ methods Live calls

    def update_display(self):
        """~100 ms tick on Live's main thread: the only place where queued work is executed."""
        self._flush_logs()
        if self._pump is None:
            return
        try:
            self._pump.drain()
        except Exception as exc:  # never raise into Live's UI thread
            self._log("update_display failed: %s: %s" % (type(exc).__name__, exc))

    def disconnect(self):
        """Close sockets, stop the thread, drop queued work. Leaves the token file alone."""
        server, self._server = self._server, None
        pump, self._pump = self._pump, None
        if server is not None:
            server.stop()
            self._log("disconnected")
        if pump is not None:
            pump.discard_pending()
        self.state.reset_connection_state()
        self._flush_logs()

    def refresh_state(self):
        pass

    def build_midi_map(self, midi_map_handle):
        pass

    def receive_midi(self, midi_bytes):
        pass

    def can_lock_to_devices(self):
        return False

    def connect_script_instances(self, instantiated_scripts):
        pass

    def suggest_input_port(self):
        return ""

    def suggest_output_port(self):
        return ""

    def suggest_map_mode(self, cc_no, channel):
        return 0

    def lock_to_device(self, device):
        pass

    def unlock_from_device(self, device):
        pass

    def toggle_lock(self):
        pass

    def restore_bank(self, bank):
        pass
