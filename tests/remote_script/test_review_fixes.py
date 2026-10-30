"""Tests added after the Opus review of T2 (one per finding or surviving mutation)."""

import ast
import os
import struct
import threading
import time
import unittest
from unittest import mock

from remote_script.BatutaMCP import runtime_files, validator as v
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.recording_safety import RecordingSafety
from remote_script.BatutaMCP.state import ScriptState
from remote_script.BatutaMCP.server import ConnectionServer

from . import fakes
from .fakes import FakeDevice, FakeRoutingType, FakeRoutingTypeNoObject, FakeSong, FakeTrack
from .test_dispatch import Harness
from .test_script import ScriptTestCase
from .test_server import ServerTestCase, TOKEN
from .test_policy import make_world

PACKAGE = os.path.join(os.path.dirname(__file__), "..", "..", "remote_script", "BatutaMCP")


class EqTrack(FakeTrack):
    """Live hands out a new Python wrapper per access; wrappers of one object compare equal."""

    def __init__(self, ident, **kwargs):
        super().__init__(**kwargs)
        self.ident = ident

    def __eq__(self, other):
        return isinstance(other, EqTrack) and other.ident == self.ident

    def __hash__(self):
        return hash(self.ident)


class RaisingArmTrack(FakeTrack):
    @property
    def arm(self):
        raise RuntimeError("Main and Return Tracks have no 'Arm' state!")

    @arm.setter
    def arm(self, value):
        pass


class RaisingMonitorTrack(FakeTrack):
    @property
    def current_monitoring_state(self):
        raise RuntimeError("no monitoring state")

    @current_monitoring_state.setter
    def current_monitoring_state(self, value):
        pass


# ---------------------------------------------------------------- MAJOR 1

class PreAuthDefectTests(ServerTestCase):
    def test_bad_json_before_auth_closes_the_connection(self):
        self.start()
        client = self.client()
        client.send_body(b"{not json")
        client.expect_closed()

    def test_invalid_utf8_before_auth_closes_the_connection(self):
        self.start()
        client = self.client()
        client.send_body(b'{"type": "\xff"}')
        client.expect_closed()


# ---------------------------------------------------------------- MAJOR 2

class StartupNeverRaisesTests(ScriptTestCase):
    def assertRefusedCleanly(self, ctx_manager):
        with ctx_manager:
            script = self.make()
        self.assertFalse(script.is_listening)
        self.assertEqual(len([l for l in self.ci.logs if "refus" in l.lower()]), 1)
        self.assertFalse(os.path.exists(self.sock_path))
        script.update_display()
        script.disconnect()
        # A reload in the same process must work: nothing leaked.
        again = self.make()
        self.assertTrue(again.is_listening)

    def test_socket_creation_failure(self):
        self.assertRefusedCleanly(mock.patch.object(runtime_files.socket, "socket",
                                                    side_effect=OSError(24, "too many open files")))

    def test_selector_failure(self):
        self.assertRefusedCleanly(mock.patch("remote_script.BatutaMCP.server.selectors.DefaultSelector",
                                             side_effect=OSError("no selector")))

    def test_socketpair_failure(self):
        self.assertRefusedCleanly(mock.patch("remote_script.BatutaMCP.server.socket.socketpair",
                                             side_effect=OSError("no pair")))

    def test_lstat_permission_error(self):
        self.assertRefusedCleanly(mock.patch.object(runtime_files.os, "lstat",
                                                    side_effect=PermissionError(13, "denied")))

    def test_unexpected_exception_type(self):
        self.assertRefusedCleanly(mock.patch("remote_script.BatutaMCP.build_registry",
                                             side_effect=ValueError("boom")))


# ---------------------------------------------------------------- MAJOR 3

class FailClosedAudioTests(unittest.TestCase):
    def rs(self, song):
        return RecordingSafety(ScriptState(), lambda: song)

    def test_only_midi_only_tracks_are_non_audio(self):
        track = FakeTrack("odd")
        track.has_midi_input = True
        track.has_audio_input = True  # both: not a plain MIDI track
        self.assertTrue(RecordingSafety.is_audio_track(track))
        track.has_midi_input = "yes"
        track.has_audio_input = False
        self.assertTrue(RecordingSafety.is_audio_track(track))
        self.assertTrue(RecordingSafety.is_audio_track(object()))
        midi = FakeTrack("m")
        self.assertFalse(RecordingSafety.is_audio_track(midi))

    def test_unknown_track_kind_cannot_be_armed(self):
        song = FakeSong(tracks=[])
        odd = object()
        with self.assertRaises(BatutaError) as ctx:
            self.rs(song).check_arm(odd)
        self.assertEqual(ctx.exception.details["reason"], "audio_arm_blocked")

    def test_arming_requires_can_be_armed_true(self):
        midi = FakeTrack("m", can_be_armed=False)
        with self.assertRaises(BatutaError):
            self.rs(FakeSong(tracks=[midi])).check_arm(midi)
        midi.can_be_armed = "yes"
        with self.assertRaises(BatutaError):
            self.rs(FakeSong(tracks=[midi])).check_arm(midi)
        midi.can_be_armed = True
        self.rs(FakeSong(tracks=[midi])).check_arm(midi)


# ---------------------------------------------------------------- MAJOR 4

class ObjectIdentityTests(unittest.TestCase):
    def test_ears_track_matched_by_equality_of_wrappers(self):
        ears = EqTrack(1, name="batuta-ears", audio=True)
        wrapper = EqTrack(1, name="batuta-ears", audio=True)
        other = EqTrack(2, name="batuta-ears", audio=True)
        song = FakeSong(tracks=[wrapper, other])
        state = ScriptState()
        rs = RecordingSafety(state, lambda: song)
        rs.register_ears_track(ears, "batuta-ears", True)
        self.assertTrue(rs.is_ears_track(wrapper))
        self.assertFalse(rs.is_ears_track(other))
        self.assertTrue(rs.is_ears_track_registered())  # found via == in the set

    def test_attached_object_wrapper_equal_to_a_set_track_is_safe(self):
        keys = EqTrack(5, name="Keys", audio=False)
        song = FakeSong(tracks=[keys, FakeTrack("Vox", audio=True)])
        rs = RecordingSafety(ScriptState(), lambda: song)
        wrapper_type = FakeRoutingType("Keys", attached_object=EqTrack(5, name="Keys"))
        self.assertTrue(rs.is_input_safe(song.tracks[1], wrapper_type))

    def test_fallback_offered_type_matched_by_equality(self):
        keys = FakeTrack("Keys")
        vox = FakeTrack("Vox", audio=True)
        song = FakeSong(tracks=[keys, vox])
        rs = RecordingSafety(ScriptState(), lambda: song)
        same = FakeRoutingTypeNoObject("Keys")
        same.__class__ = type("Eq", (FakeRoutingTypeNoObject,),
                              {"__eq__": lambda a, b: a.display_name == b.display_name,
                               "__hash__": lambda a: 1})
        vox.available_input_routing_types = [FakeRoutingTypeNoObject("Keys")]
        # Without equality the offered copy would count as a second "Keys" and be unsafe.
        class Twin(FakeRoutingTypeNoObject):
            def __eq__(self, other):
                return self.display_name == other.display_name
            __hash__ = None
        vox.available_input_routing_types = [Twin("Keys")]
        self.assertTrue(rs.is_input_safe(vox, Twin("Keys")))


# ---------------------------------------------------------------- MAJOR 5

class UnarmableTrackTests(unittest.TestCase):
    def test_arm_read_runtime_error_is_swallowed_and_device_check_still_runs(self):
        ret = RaisingArmTrack("A-Return", audio=True, can_be_armed=False)
        ret.devices = [FakeDevice("External Audio Effect", "ExternalAudioEffect")]
        song = FakeSong(tracks=[], returns=[ret])
        rs = RecordingSafety(ScriptState(), lambda: song)
        self.assertEqual(rs.external_live_tracks(), ["A-Return"])
        ret.devices = []
        self.assertEqual(rs.external_live_tracks(), [])

    def test_arm_is_not_read_when_track_cannot_be_armed(self):
        reads = []

        class Spy(FakeTrack):
            @property
            def arm(self):
                reads.append(1)
                return True

            @arm.setter
            def arm(self, value):
                pass

        track = Spy("g", audio=True, can_be_armed=False)
        song = FakeSong(tracks=[track])
        RecordingSafety(ScriptState(), lambda: song).external_live_tracks()
        self.assertEqual(reads, [])

    def test_monitoring_read_runtime_error_is_swallowed(self):
        track = RaisingMonitorTrack("t", audio=True)
        song = FakeSong(tracks=[track])
        self.assertEqual(RecordingSafety(ScriptState(), lambda: song).external_live_tracks(), [])


# ---------------------------------------------------------------- MAJOR 6 and surviving mutations

class SurvivingMutationTests(unittest.TestCase):
    def test_attached_object_outside_this_set_is_not_safe(self):  # M5
        state, song, midi, audio, safe, ext = make_world()
        rs = RecordingSafety(state, lambda: song)
        alien = FakeRoutingType("Alien", attached_object=FakeTrack("Alien", audio=True))
        self.assertFalse(rs.is_input_safe(audio, alien))

    def test_fallback_collision_for_names_other_than_ext_in(self):  # M10
        state, song, midi, audio, safe, ext = make_world()
        rs = RecordingSafety(state, lambda: song)
        song.tracks.append(FakeTrack("Foo"))
        song.tracks.append(FakeTrack("Foo"))
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingTypeNoObject("Foo")))
        song.tracks.append(FakeTrack("No Input"))
        self.assertFalse(rs.is_input_safe(audio, FakeRoutingTypeNoObject("No Input")))
        song.tracks.append(FakeTrack("Solo"))
        twin_a, twin_b = FakeRoutingTypeNoObject("Solo"), FakeRoutingTypeNoObject("Solo")
        audio.available_input_routing_types = [twin_a, twin_b]
        self.assertFalse(rs.is_input_safe(audio, twin_a))
        audio.available_input_routing_types = [twin_a]
        self.assertTrue(rs.is_input_safe(audio, twin_a))

    def test_token_comparison_uses_hmac_compare_digest(self):  # M12
        with open(os.path.join(PACKAGE, "server.py"), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute) and n.func.attr == "compare_digest"
                 and isinstance(n.func.value, ast.Name) and n.func.value.id == "hmac"]
        self.assertTrue(calls)
        for node in ast.walk(tree):
            if isinstance(node, ast.Compare) and any(isinstance(op, (ast.Eq, ast.NotEq)) for op in node.ops):
                operands = [x for x in [node.left] + node.comparators
                            if not (isinstance(x, ast.Call) and isinstance(x.func, ast.Name)
                                    and x.func.id == "len")]  # comparing lengths is fine
                names = [ast.dump(x) for x in operands]
                self.assertFalse(any("token" in n.lower() for n in names),
                                 "token compared with ==/!= at line %d" % node.lineno)


class ConsecutiveBadFrameTests(ServerTestCase):  # M18 and ping/bucket rules
    def bad(self, client, count):
        for _ in range(count):
            client.send_body(b"{bad")
            self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")

    def test_valid_call_resets_the_counter(self):
        self.start()
        client = self.ready()
        self.bad(client, 4)
        self.request(client, 1, "rm_rf", {})
        client.recv_frame()
        self.bad(client, 4)
        client.send_frame({"type": "ping"})
        self.assertEqual(client.recv_frame(), {"type": "pong"})

    def test_ping_does_not_reset_the_counter(self):
        self.start()
        client = self.ready()
        self.bad(client, 4)
        client.send_frame({"type": "ping"})
        client.recv_frame()
        client.send_body(b"{bad")
        self.assertEqual(client.expect_closed()[0]["error"]["code"], "bad_request")

    def test_bad_frames_are_charged_to_the_token_bucket(self):
        self.start(rate_per_s=0.01, burst=2)
        client = self.ready()
        codes = []
        for _ in range(4):
            client.send_body(b"{bad")
            codes.append(client.recv_frame()["error"]["code"])
        self.assertEqual(codes, ["bad_request", "bad_request", "rate_limited", "rate_limited"])


class OutputBackpressureTests(ServerTestCase):
    def test_client_that_reads_normally_gets_every_large_response(self):
        self.start()
        client = self.ready()
        for request_id in range(1, 7):
            self.request(client, request_id, "big", {"n": 900000})
        self.drain_until(6)  # all 6 finish in one tick; ~5.4 MB is queued for the socket
        ids = []
        for _ in range(6):
            frame = client.recv_frame()
            self.assertTrue(frame["ok"])
            ids.append(frame["id"])
        self.assertEqual(ids, [1, 2, 3, 4, 5, 6])
        self.request(client, 7)  # reading resumed once the backlog drained
        self.drain_until()
        self.assertEqual(client.recv_frame()["id"], 7)

    def test_no_new_calls_are_accepted_while_the_backlog_is_over_the_soft_cap(self):
        self.start()
        client = self.ready()
        for request_id in range(1, 7):
            self.request(client, request_id, "big", {"n": 900000})
        self.drain_until(6)
        self.request(client, 50)  # sent while the server is not reading from us
        time.sleep(0.2)
        self.assertTrue(self.inbound.empty())
        for _ in range(6):
            client.recv_frame()
        self.drain_until()
        self.assertEqual(client.recv_frame()["id"], 50)

    def test_body_timeout_does_not_run_while_reading_is_paused(self):
        self.start(body_timeout=1.5)  # generous: the timer restarts when reading resumes, while the client still drains 5 MB
        client = self.ready()
        for request_id in range(1, 7):
            self.request(client, request_id, "big", {"n": 900000})
        client.send_raw(struct.pack(">I", 100) + b"0123456789")  # half a frame
        time.sleep(0.1)
        self.drain_until(6)  # backlog is now over the soft cap: the server stops reading
        time.sleep(2.0)  # well past body_timeout while the client has not read yet
        for _ in range(6):
            self.assertTrue(client.recv_frame()["ok"])
        client.send_raw(b"x" * 90)  # finish the frame promptly after the backlog drained
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")

    def test_never_reading_client_hits_the_hard_cap(self):
        with mock.patch("remote_script.BatutaMCP.server._MAX_OUTBUF_HARD_BYTES", 2_000_000):
            self.start(send_timeout=60.0)
            client = self.ready()
            client.sock.setsockopt(__import__("socket").SOL_SOCKET, __import__("socket").SO_RCVBUF, 4096)
            for request_id in range(1, 9):
                self.request(client, request_id, "big", {"n": 900000})
            deadline = time.monotonic() + 3.0
            while self.server.current_conn_id is not None and time.monotonic() < deadline:
                self.pump.drain()
                time.sleep(0.01)
            self.assertIsNone(self.server.current_conn_id)


class SocketIdentityTests(ServerTestCase):
    def test_stop_does_not_unlink_a_replaced_socket_file(self):
        self.start()
        os.unlink(self.path)
        import socket
        other = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(other.close)
        other.bind(self.path)
        self.server.stop()
        self.assertTrue(os.path.exists(self.path))

    def test_stop_unlinks_its_own_socket_file(self):
        self.start()
        self.server.stop()
        self.assertFalse(os.path.exists(self.path))

    def test_stop_is_fast(self):
        self.start()
        self.ready()
        began = time.monotonic()
        self.server.stop()
        self.assertLess(time.monotonic() - began, 0.5)


class LoggingThreadTests(ScriptTestCase):
    def test_log_message_is_only_called_from_the_constructing_thread(self):
        main = threading.get_ident()
        script = self.make()
        client, _ = self.connect()
        client.close()
        time.sleep(0.3)
        self.assertNotIn("BatutaMCP: client connected", self.ci.logs)  # still queued
        script.update_display()
        self.assertIn("BatutaMCP: client connected", self.ci.logs)
        script.disconnect()
        self.assertEqual(set(self.ci.log_threads), {main})


# ---------------------------------------------------------------- minor policy items

class ArmReadFailureTests(unittest.TestCase):
    def test_arm_read_error_on_an_armable_track_fails_closed(self):  # M26
        track = RaisingArmTrack("Vox", audio=True, can_be_armed=True)
        track.input_routing_type = FakeRoutingType("Ext. In")
        song = FakeSong(tracks=[track])
        rs = RecordingSafety(ScriptState(), lambda: song)
        self.assertEqual(rs.external_live_tracks(), ["Vox"])
        track.input_routing_type = FakeRoutingType("Resampling")
        self.assertEqual(rs.external_live_tracks(), [])  # a SAFE input is fine either way


class ListenerCleanupTests(unittest.TestCase):
    def test_failed_chmod_or_listen_leaves_no_socket_file(self):
        directory = fakes.short_tmpdir()
        self.addCleanup(fakes.remove_tree, directory)
        path = os.path.join(directory, "live.sock")
        with mock.patch.object(runtime_files.os, "chmod", side_effect=OSError(1, "nope")):
            with self.assertRaises(runtime_files.RuntimeFileError):
                runtime_files.prepare_listener(path)
        self.assertFalse(os.path.exists(path))
        real_socket = runtime_files.socket.socket

        class NoListen(real_socket):
            def listen(self, backlog):
                raise OSError(1, "no listen")

        with mock.patch.object(runtime_files.socket, "socket", NoListen):
            with self.assertRaises(runtime_files.RuntimeFileError):
                runtime_files.prepare_listener(path)
        self.assertFalse(os.path.exists(path))


class MinorPolicyTests(unittest.TestCase):
    def test_ambiguous_candidates_report_real_positions(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = RecordingSafety(state, lambda: song)
        items = [FakeRoutingType("A"), FakeRoutingType("X"), FakeRoutingType("A")]
        with self.assertRaises(BatutaError) as ctx:
            rs.resolve_routing_type(items, "A")
        self.assertEqual([c["index"] for c in ctx.exception.details["candidates"]], [0, 2])

    def test_names_in_details_are_cleaned_and_capped(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = RecordingSafety(state, lambda: song)
        dirty = FakeRoutingType("x\x00" + "y" * 300)
        with self.assertRaises(BatutaError) as ctx:
            rs.resolve_routing_type([dirty], "nope")
        shown = ctx.exception.details["available"][0]
        self.assertLessEqual(len(shown), 128)
        self.assertNotIn("\x00", shown)
        audio.arm = True
        audio.name = "v\x00" + "z" * 300
        with self.assertRaises(BatutaError) as ctx:
            rs.check_record_start("slot_fire")
        shown = ctx.exception.details["tracks"][0]
        self.assertLessEqual(len(shown), 128)
        self.assertNotIn("\x00", shown)

    def test_lone_surrogates_rejected(self):
        with self.assertRaises(BatutaError):
            v.validate(v.string(), "a\ud800b")
        from remote_script.BatutaMCP.textutil import clean
        self.assertEqual(clean("a\udc00b", 10), "ab")

    def test_global_device_budget_fails_closed(self):
        tracks = []
        for index in range(5):
            track = FakeTrack("T%d" % index, audio=True)
            track.devices = [FakeDevice("D%d" % i) for i in range(450)]  # under 500 each, 2250 total
            tracks.append(track)
        rs = RecordingSafety(ScriptState(), lambda: FakeSong(tracks=tracks))
        found = rs.external_live_tracks()
        self.assertIn("T4", found)
        self.assertNotIn("T0", found)

    def test_ears_precheck_runs_before_creation(self):
        state, song, midi, audio, safe, ext = make_world()
        rs = RecordingSafety(state, lambda: song)
        rs.precheck_ears_track("batuta-ears", True)
        rs.register_ears_track(audio, "batuta-ears", True)
        with self.assertRaises(BatutaError) as ctx:
            rs.precheck_ears_track("batuta-ears", True)
        self.assertEqual(ctx.exception.details["reason"], "ears_exists")
        with self.assertRaises(BatutaError):
            rs.precheck_ears_track("batuta-ears", False)


class PrecheckHookTests(unittest.TestCase):
    def test_precheck_runs_before_the_undo_step_and_can_reject(self):
        from remote_script.BatutaMCP.registry import Command
        h = Harness()
        seen = []

        def reject(ctx, args):
            seen.append(list(h.song.events))
            raise BatutaError("not_found", "nope")

        h.registry._commands["mutate"] = Command("mutate", v.obj({}), lambda c, a: {},
                                                 mutating=True, precheck=reject)
        response = h.run("mutate")
        self.assertEqual(response["error"]["code"], "not_found")
        self.assertEqual(seen, [[]])
        self.assertEqual(h.song.events, [])


class StaticReflectionTests(unittest.TestCase):
    def test_no_reflection_escape_hatches(self):
        import glob
        for path in glob.glob(os.path.join(PACKAGE, "*.py")):
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read())
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute):
                    self.assertNotIn(node.attr, ("__getattribute__", "__dict__", "__class__",
                                                 "__subclasses__", "__globals__", "__builtins__"),
                                     "%s:%d" % (path, node.lineno))
                    self.assertNotEqual(node.attr, "attrgetter")
                if isinstance(node, ast.Name):
                    self.assertNotEqual(node.id, "attrgetter")


if __name__ == "__main__":
    unittest.main()
