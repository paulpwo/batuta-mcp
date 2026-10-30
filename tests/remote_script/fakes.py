"""Test doubles for the BatutaMCP Remote Script: fake Live module, c_instance, song and a socket client."""

import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import types


# ---------------------------------------------------------------- Live module

VIEW_NAMES = ("Browser", "Arranger", "Session", "Detail", "Detail/Clip", "Detail/DeviceChain")
_MAIN_VIEWS = ("Arranger", "Session")


class FakeAppView:
    """Live.Application.View: show_view / focus_view / is_view_visible over Live's view names."""

    def __init__(self):
        self.calls = []
        self.visible = {"Session"}
        self.fail_with = None

    def _check(self, name):
        if self.fail_with is not None:
            raise self.fail_with
        if type(name) is not str or name not in VIEW_NAMES:
            raise RuntimeError("Invalid view name: %r" % (name,))

    def show_view(self, name):
        self._check(name)
        self.calls.append(("show_view", name))
        if name in _MAIN_VIEWS:
            self.visible -= set(_MAIN_VIEWS)
        self.visible.add(name)

    def focus_view(self, name):
        self._check(name)
        self.calls.append(("focus_view", name))
        self.show_view(name)
        del self.calls[-1]  # focusing shows it too; record only the focus call

    def is_view_visible(self, name):
        self._check(name)
        return name in self.visible


class _FakeApplication:
    def __init__(self, version):
        self._version = version
        self.view = FakeAppView()

    def get_version_string(self):
        return self._version


def install_fake_live(version="12.4.7"):
    """Install a fake `Live` module in sys.modules and return it (one shared application)."""
    module = types.ModuleType("Live")
    app = _FakeApplication(version)
    module.Application = types.SimpleNamespace(get_application=lambda: app)
    sys.modules["Live"] = module
    return module


def uninstall_fake_live():
    sys.modules.pop("Live", None)


# ---------------------------------------------------------------- LOM fakes

class FakeRoutingType:
    def __init__(self, display_name, attached_object=None):
        self.display_name = display_name
        self.attached_object = attached_object


class FakeRoutingTypeNoObject:
    """A routing type that exposes no `attached_object` (assumption A35 false)."""

    def __init__(self, display_name):
        self.display_name = display_name


class FakeDevice:
    def __init__(self, name="Device", class_name="Generic", chains=None,
                 return_chains=None, drum_pads=None):
        self.name = name
        self.class_name = class_name
        if chains is not None:
            self.chains = chains
        if return_chains is not None:
            self.return_chains = return_chains
        if drum_pads is not None:
            self.drum_pads = drum_pads


class FakeChain:
    def __init__(self, devices=None):
        self.devices = devices or []


class FakeDrumPad:
    def __init__(self, chains=None):
        self.chains = chains or []


class FakeTrack:
    def __init__(self, name="Track", audio=False, arm=False, monitoring=1,
                 devices=None, input_type=None, available_inputs=None, can_be_armed=True):
        self.name = name
        self.can_be_armed = can_be_armed
        self.has_audio_input = audio
        self.has_midi_input = not audio
        self.arm = arm
        self.current_monitoring_state = monitoring
        self.devices = devices or []
        self.input_routing_type = input_type
        self.available_input_routing_types = available_inputs or []


class FakeSong:
    def __init__(self, tracks=None, returns=None, scenes=0):
        self.tracks = tracks or []
        self.return_tracks = returns or []
        self.master_track = FakeTrack("Master")
        self.scenes = [object() for _ in range(scenes)]
        self.record_mode = False
        self.session_record = False
        self.events = []

    def begin_undo_step(self):
        self.events.append("begin")

    def end_undo_step(self):
        self.events.append("end")


class FakeCInstance:
    def __init__(self, song=None):
        self._song = song or FakeSong()
        self.logs = []
        self.log_threads = []
        self.messages = []  # status bar lines shown through show_message
        self.message_error = None  # set to an exception to make show_message raise
        self.message_hook = None  # optional callable(text), runs when show_message is called

    def song(self):
        return self._song

    def show_message(self, text):
        if self.message_hook is not None:
            self.message_hook(text)
        if self.message_error is not None:
            raise self.message_error
        self.messages.append(text)

    def log_message(self, message):
        self.log_threads.append(threading.get_ident())
        self.logs.append(message)


class FakeClock:
    def __init__(self, start=100.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


# ---------------------------------------------------------------- filesystem

def short_tmpdir():
    """A short, 0700 temp dir under /tmp so AF_UNIX paths stay below 104 bytes."""
    return tempfile.mkdtemp(dir="/tmp")


def remove_tree(path):
    shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------- socket client

class WireClient:
    """Minimal blocking client speaking the length-prefixed JSON framing."""

    def __init__(self, path, timeout=3.0):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        try:
            self.sock.connect(path)
        except OSError:
            self.sock.close()
            raise
        self._buffer = b""

    def send_raw(self, data):
        self.sock.sendall(data)

    def send_frame(self, obj):
        body = json.dumps(obj).encode("utf-8")
        self.sock.sendall(struct.pack(">I", len(body)) + body)

    def try_send_frame(self, obj):
        """Send a frame, ignoring a peer that has already closed (the server may drop us first)."""
        try:
            self.send_frame(obj)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_body(self, body):
        self.sock.sendall(struct.pack(">I", len(body)) + body)

    def _read_exact(self, count):
        while len(self._buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("connection closed")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def recv_frame(self):
        header = self._read_exact(4)
        (length,) = struct.unpack(">I", header)
        return json.loads(self._read_exact(length).decode("utf-8"))

    def recv_or_eof(self):
        """Return the next frame, or None when the peer closed the connection."""
        try:
            return self.recv_frame()
        except (EOFError, ConnectionResetError, BrokenPipeError):
            return None

    def expect_closed(self, wait=3.0):
        """Drain frames until EOF; return the frames received."""
        frames = []
        deadline = time.monotonic() + wait
        self.sock.settimeout(0.2)
        while time.monotonic() < deadline:
            try:
                frames.append(self.recv_frame())
            except socket.timeout:
                continue
            except (EOFError, ConnectionResetError, BrokenPipeError):
                return frames
        raise AssertionError("connection was not closed; frames=%r" % (frames,))

    def handshake(self, token, **extra):
        hello = {"type": "hello", "protocol": 1, "token": token}
        hello.update(extra)
        self.send_frame(hello)
        return self.recv_frame()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def wait_until(predicate, timeout=3.0, step=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


def mode_of(path):
    return os.lstat(path).st_mode & 0o777
