import dataclasses
import os
import queue
import socket
import struct
import time
import unittest

from remote_script.BatutaMCP import runtime_files
from remote_script.BatutaMCP.dispatcher import MainThreadPump
from remote_script.BatutaMCP.server import ConnectionServer, ServerConfig

from . import fakes
from .test_dispatch import Harness

TOKEN = b"0123456789abcdef" * 4


class ServerTestCase(unittest.TestCase):
    def start(self, queue_max=64, **overrides):
        self.dir = fakes.short_tmpdir()
        self.addCleanup(fakes.remove_tree, self.dir)
        self.path = os.path.join(self.dir, "live.sock")
        self.logs = []
        self.hints = []
        self.config = dataclasses.replace(ServerConfig(), tick=0.01, **overrides)
        self.h = Harness(clock=time.monotonic)
        self.inbound = queue.Queue(maxsize=queue_max)
        listener = runtime_files.prepare_listener(self.path)

        def welcome(hint):
            self.hints.append(hint)
            return {"type": "welcome", "protocol": 1, "script_version": "test"}

        self.server = ConnectionServer(listener, self.path, TOKEN, self.inbound,
                                       self.h.registry, welcome, self.logs.append,
                                       config=self.config)
        self.pump = MainThreadPump(self.inbound, self.h.dispatcher, self.server.post_response,
                                   self.server.is_live, clock=time.monotonic)
        self.server.start()
        self.addCleanup(self.server.stop)
        self.clients = []
        self.addCleanup(lambda: [c.close() for c in self.clients])

    def client(self):
        client = fakes.WireClient(self.path)
        self.clients.append(client)
        return client

    def ready(self, **hello_extra):
        client = self.client()
        welcome = client.handshake(TOKEN.decode(), **hello_extra)
        self.assertEqual(welcome["type"], "welcome")
        return client

    def request(self, client, request_id, cmd="echo", args=None, **extra):
        frame = {"id": request_id, "cmd": cmd, "args": {"v": 1} if args is None else args}
        frame.update(extra)
        client.send_frame(frame)

    def drain_until(self, count=1, timeout=3.0):
        """Run the pump (as update_display would) until `count` items were executed."""
        done = 0
        deadline = time.monotonic() + timeout
        while done < count and time.monotonic() < deadline:
            done += self.pump.drain()
            time.sleep(0.005)
        self.assertGreaterEqual(done, count)

    def conn_closed(self, timeout=3.0):
        return fakes.wait_until(lambda: self.server.current_conn_id is None, timeout)


class HandshakeTests(ServerTestCase):
    def test_good_token_gets_welcome_and_hint_is_forwarded(self):
        self.start()
        client = self.client()
        welcome = client.handshake(TOKEN.decode(), edition_hint="lite", client="batuta-mcp/0.1.0")
        self.assertEqual(welcome["type"], "welcome")
        self.assertEqual(self.hints, ["lite"])

    def test_hello_flags_reach_the_handlers(self):
        self.start()
        client = self.ready(allow_plugins=True)
        self.request(client, 1, "flags", {})
        self.drain_until()
        self.assertEqual(client.recv_frame()["result"],
                         {"allow_plugins": True, "allow_user_presets": False, "allow_audio_import": False,
                          "allow_max_for_live": False, "allow_external_devices": False})

    def test_max_for_live_flag_reaches_the_handlers(self):
        self.start()
        client = self.ready(allow_max_for_live=True)
        self.request(client, 1, "flags", {})
        self.drain_until()
        self.assertTrue(client.recv_frame()["result"]["allow_max_for_live"])

    def test_external_input_ack_is_per_request_and_must_be_a_track_id_object(self):
        self.start()
        client = self.ready()
        self.request(client, 1, "flags", {}, external_input_ack={"tracks": ["t1", "m"]})
        self.request(client, 2, "flags", {})
        self.drain_until(2)
        first, second = client.recv_frame(), client.recv_frame()
        self.assertEqual(first["result"]["external_input_ack"], ["t1", "m"])
        self.assertNotIn("external_input_ack", second["result"])
        bad = (True, "yes", {"tracks": "t1"}, {"tracks": ["x9"]}, {"tracks": [1]}, {"tracks": [], "all": True}, {},
               {"tracks": ["t1"] * 257})
        for value in bad:
            self.request(client, 99, "flags", {}, external_input_ack=value)
            self.assertEqual(client.recv_frame()["error"]["code"], "bad_request", value)
            self.request(client, 98, "rm_rf", {})  # a well-formed call resets the consecutive-defect counter
            client.recv_frame()

    def test_audio_import_flag_reaches_the_handlers(self):
        self.start()
        client = self.ready(allow_audio_import=True)
        self.request(client, 1, "flags", {})
        self.drain_until()
        self.assertTrue(client.recv_frame()["result"]["allow_audio_import"])

    def test_bad_token_gets_auth_failed_and_close_and_is_never_logged(self):
        self.start()
        client = self.client()
        bad = "f" * 64
        client.send_frame({"type": "hello", "protocol": 1, "token": bad})
        frames = client.expect_closed()
        self.assertEqual(frames[0]["error"]["code"], "auth_failed")
        self.assertNotIn(TOKEN.decode(), "".join(self.logs))
        self.assertNotIn(bad, "".join(self.logs))

    def test_odd_tokens_are_auth_failures_not_crashes(self):
        self.start(lockout_failures=100)
        for token in ("", "a" * 63, "a" * 65, "é" * 64, TOKEN.decode().upper()):
            client = self.client()
            client.send_frame({"type": "hello", "protocol": 1, "token": token})
            frames = client.expect_closed()
            self.assertEqual(frames[0]["error"]["code"], "auth_failed", repr(token))

    def test_non_string_token_is_a_bad_request(self):
        self.start()
        client = self.client()
        client.send_frame({"type": "hello", "protocol": 1, "token": 12})
        self.assertEqual(client.expect_closed()[0]["error"]["code"], "bad_request")

    def test_protocol_mismatch(self):
        self.start(lockout_failures=100)
        for protocol in (2, 0, True, "1", 1.0, None):
            client = self.client()
            client.send_frame({"type": "hello", "protocol": protocol, "token": TOKEN.decode()})
            frames = client.expect_closed()
            self.assertEqual(frames[0]["error"]["code"], "bad_request", repr(protocol))
            self.assertEqual(frames[0]["error"]["details"], {"supported": [1]})

    def test_invalid_optional_hello_fields(self):
        self.start()
        for extra in ({"allow_plugins": "yes"}, {"edition_hint": "gold"}, {"client": "x" * 65},
                      {"allow_user_presets": 1}, {"allow_audio_import": "yes"}, {"allow_max_for_live": "yes"}, {"surprise": 1}):
            client = self.client()
            hello = {"type": "hello", "protocol": 1, "token": TOKEN.decode()}
            hello.update(extra)
            client.send_frame(hello)
            self.assertEqual(client.expect_closed()[0]["error"]["code"], "bad_request", extra)

    def test_first_frame_must_be_hello(self):
        self.start()
        for frame in ({"id": 1, "cmd": "echo", "args": {"v": 1}}, {"type": "ping"},
                      {"type": "welcome"}):
            client = self.client()
            client.send_frame(frame)
            client.expect_closed()

    def test_silent_client_is_dropped_after_hello_timeout(self):
        self.start(hello_timeout=0.2)
        client = self.client()
        client.expect_closed()

    def test_lockout_after_repeated_failures_then_recovery(self):
        self.start(lockout_failures=3, lockout_duration=0.5)
        for _ in range(3):
            client = self.client()
            client.send_frame({"type": "hello", "protocol": 1, "token": "0" * 64})
            client.expect_closed()
            self.assertTrue(self.conn_closed())
        locked = self.client()
        locked.try_send_frame({"type": "hello", "protocol": 1, "token": TOKEN.decode()})
        self.assertEqual(locked.expect_closed(), [])  # closed silently, no reply
        time.sleep(0.6)
        self.ready()


class SessionTests(ServerTestCase):
    def test_second_client_gets_busy_and_first_is_unaffected(self):
        self.start()
        first = self.ready()
        second = self.client()
        frames = second.expect_closed()
        self.assertEqual(frames[0]["type"], "error")
        self.assertEqual(frames[0]["error"]["code"], "busy")
        first.send_frame({"type": "ping"})
        self.assertEqual(first.recv_frame(), {"type": "pong"})

    def test_second_client_is_not_read_from(self):
        self.start()
        self.ready()
        second = self.client()
        second.try_send_frame({"type": "hello", "protocol": 1, "token": "0" * 64})
        second.expect_closed()
        self.assertEqual(self.server.auth_failures, 0)

    def test_slot_is_freed_when_the_client_leaves(self):
        self.start()
        first = self.ready()
        first.close()
        self.assertTrue(self.conn_closed())
        self.ready()

    def test_idle_timeout_frees_the_slot(self):
        self.start(idle_timeout=0.3)
        client = self.ready()
        client.expect_closed()
        self.assertTrue(self.conn_closed())

    def test_ping_keeps_the_connection_alive(self):
        self.start(idle_timeout=0.5)
        client = self.ready()
        for _ in range(4):
            time.sleep(0.2)
            client.send_frame({"type": "ping"})
            self.assertEqual(client.recv_frame(), {"type": "pong"})

    def test_ping_before_auth_is_a_defect_and_after_is_a_pong(self):
        self.start()
        client = self.ready()
        client.send_frame({"type": "ping"})
        self.assertEqual(client.recv_frame(), {"type": "pong"})

    def test_partial_frame_body_times_out(self):
        self.start(body_timeout=0.3)
        client = self.ready()
        client.send_raw(struct.pack(">I", 100) + b"0123456789")
        client.expect_closed()

    def test_server_stop_closes_everything_and_removes_socket(self):
        self.start()
        client = self.ready()
        self.server.stop()
        client.expect_closed()
        self.assertFalse(os.path.exists(self.path))
        self.assertFalse(self.server.is_running)
        self.server.stop()  # idempotent
        with self.assertRaises(OSError):
            self.client()

    def test_stop_without_a_client(self):
        self.start()
        self.server.stop()
        self.assertFalse(os.path.exists(self.path))


class RequestTests(ServerTestCase):
    def test_nothing_executes_until_the_pump_drains(self):
        self.start()
        client = self.ready()
        self.request(client, 5)
        client.sock.settimeout(0.3)
        with self.assertRaises(socket.timeout):
            client.recv_frame()
        self.drain_until()
        client.sock.settimeout(3)
        self.assertEqual(client.recv_frame(), {"id": 5, "ok": True, "result": {"v": 1}})

    def test_responses_follow_request_order(self):
        self.start()
        client = self.ready()
        for request_id in (9, 3, 7, 1):
            self.request(client, request_id)
        self.drain_until(4)
        self.assertEqual([client.recv_frame()["id"] for _ in range(4)], [9, 3, 7, 1])

    def test_unknown_command(self):
        self.start()
        client = self.ready()
        for name in ("rm_rf", "getattr", "__import__", "Echo"):
            self.request(client, 1, name, {})
            error = client.recv_frame()["error"]
            self.assertEqual(error["code"], "unknown_command")
            self.assertEqual(error["details"], {"cmd": name})
        self.assertTrue(self.inbound.empty())

    def test_invalid_args_do_not_reach_the_queue(self):
        self.start()
        client = self.ready()
        self.request(client, 1, "echo", {"v": "nope"})
        frame = client.recv_frame()
        self.assertEqual((frame["id"], frame["error"]["code"]), (1, "invalid_args"))
        self.request(client, 2, "echo", {"v": True})
        self.assertEqual(client.recv_frame()["error"]["code"], "invalid_args")
        self.assertTrue(self.inbound.empty())

    def test_control_characters_in_strings_are_invalid_args(self):
        self.start()
        client = self.ready()
        self.request(client, 1, "echo", {"v": 1, "x": "a\x00b"})
        self.assertEqual(client.recv_frame()["error"]["code"], "invalid_args")

    def test_envelope_defects_are_bad_requests_and_keep_the_connection(self):
        self.start()
        client = self.ready()
        bad_frames = [
            {"id": 1, "cmd": "echo"},                           # args missing
            {"id": 1, "cmd": "echo", "args": {"v": 1}, "x": 1},  # unknown top-level key
            {"id": True, "cmd": "echo", "args": {"v": 1}},      # bool id
            {"id": -1, "cmd": "echo", "args": {"v": 1}},
            {"id": 2 ** 53 + 2, "cmd": "echo", "args": {"v": 1}},
            {"id": 1.5, "cmd": "echo", "args": {"v": 1}},
            {"id": 1, "cmd": 5, "args": {"v": 1}},
            {"id": 1, "cmd": "echo", "args": [1]},
            {"id": 1, "cmd": "echo", "args": {"v": 1}, "timeout_ms": 50},
            {"id": 1, "cmd": "echo", "args": {"v": 1}, "timeout_ms": 30001},
            {"id": 1, "cmd": "echo", "args": {"v": 1}, "timeout_ms": True},
            {"type": "weird"},
            {},
        ]
        for index, frame in enumerate(bad_frames):
            client.send_frame(frame)
            self.assertEqual(client.recv_frame()["error"]["code"], "bad_request", frame)
            if index % 2:  # a well-formed call resets the consecutive-defect counter
                self.request(client, 99, "rm_rf", {})
                client.recv_frame()

    def test_bad_request_echoes_the_id_when_recoverable(self):
        self.start()
        client = self.ready()
        client.send_frame({"id": 8, "cmd": "echo", "args": [1]})
        frame = client.recv_frame()
        self.assertEqual(frame["id"], 8)
        client.send_frame({"cmd": "echo", "args": {}})
        self.assertIsNone(client.recv_frame()["id"])

    def test_duplicate_inflight_id_is_rejected(self):
        self.start()
        client = self.ready()
        self.request(client, 4)
        self.request(client, 4)
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")
        self.drain_until()
        self.assertTrue(client.recv_frame()["ok"])
        self.request(client, 4)  # reusable once answered
        self.drain_until()
        self.assertTrue(client.recv_frame()["ok"])

    def test_invalid_utf8_and_bad_json_keep_the_connection(self):
        self.start()
        client = self.ready()
        client.send_body(b'{"id": 1, "cmd": "\xff\xfe"}')
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")
        client.send_body(b"{not json")
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")
        client.send_body(b'{"id": 1, "cmd": "echo", "args": {"v": NaN}}')
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")
        client.send_body(b'{"id": 1, "cmd": "echo", "args": {"v": 1e999}}')
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")
        client.send_body(b"[1]")
        self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")

    def test_five_consecutive_bad_frames_close_the_connection(self):
        self.start()
        client = self.ready()
        for _ in range(4):
            client.send_body(b"{bad")
            self.assertEqual(client.recv_frame()["error"]["code"], "bad_request")
        self.request(client, 99, "rm_rf", {})
        client.recv_frame()
        for _ in range(4):
            client.send_body(b"{bad")
            client.recv_frame()
        client.send_body(b"{bad")
        frames = client.expect_closed()
        self.assertEqual(frames[0]["error"]["code"], "bad_request")

    def test_oversize_frame_header_gets_too_large_and_close(self):
        self.start()
        client = self.ready()
        client.send_raw(struct.pack(">I", 2_000_000))
        frames = client.expect_closed()
        self.assertEqual(frames[0]["error"]["code"], "too_large")

    def test_zero_length_frame_closes(self):
        self.start()
        client = self.ready()
        client.send_raw(struct.pack(">I", 0))
        self.assertEqual(client.expect_closed()[0]["error"]["code"], "bad_request")

    def test_requests_of_a_departed_client_are_never_executed(self):
        self.start()
        client = self.ready()
        self.request(client, 1, "mutate", {})
        time.sleep(0.1)
        client.close()
        self.assertTrue(self.conn_closed())
        self.pump.drain()
        self.assertEqual(self.h.song.events, [])

    def test_oversize_result_becomes_too_large_error(self):
        self.start()
        client = self.ready()
        self.request(client, 1, "big", {})
        self.drain_until()
        frame = client.recv_frame()
        self.assertEqual((frame["id"], frame["ok"], frame["error"]["code"]), (1, False, "too_large"))

    def test_unserializable_result_becomes_an_error_response(self):
        self.start()
        client = self.ready()
        self.request(client, 1, "unser", {})
        self.drain_until()
        frame = client.recv_frame()
        self.assertEqual((frame["id"], frame["ok"], frame["error"]["code"]), (1, False, "lom_error"))

    def test_request_contents_are_never_logged(self):
        self.start()
        client = self.ready()
        client.send_frame({"id": 1, "cmd": "echo", "args": {"v": 1, "marker": "SECRET-MARKER"}})
        client.recv_frame()
        client.send_body(b'{"junk": "SECRET-MARKER"')
        client.recv_frame()
        self.assertNotIn("SECRET-MARKER", "".join(self.logs))
        self.assertNotIn(TOKEN.decode(), "".join(self.logs))


class FlowControlTests(ServerTestCase):
    def test_rate_limit_rejects_excess_with_retry_hint_and_ping_is_exempt(self):
        self.start(rate_per_s=0.5, burst=3)
        client = self.ready()
        for request_id in range(1, 9):
            self.request(client, request_id)
        limited = []
        for _ in range(5):
            frame = client.recv_frame()
            self.assertEqual(frame["error"]["code"], "rate_limited")
            self.assertGreater(frame["error"]["details"]["retry_after_ms"], 0)
            limited.append(frame["id"])
        self.assertEqual(limited, [4, 5, 6, 7, 8])
        self.drain_until(3)
        self.assertEqual([client.recv_frame()["id"] for _ in range(3)], [1, 2, 3])
        for _ in range(10):
            client.send_frame({"type": "ping"})
            self.assertEqual(client.recv_frame(), {"type": "pong"})

    def test_sustained_violator_is_disconnected(self):
        self.start(rate_per_s=0.1, burst=1, reject_threshold=5)
        client = self.ready()
        for request_id in range(1, 30):
            try:
                self.request(client, request_id)
            except OSError:
                break
        frames = client.expect_closed()
        self.assertTrue(all(f["error"]["code"] == "rate_limited" for f in frames))
        self.assertTrue(self.conn_closed())

    def test_inflight_cap(self):
        self.start(max_inflight=3)
        client = self.ready()
        for request_id in (1, 2, 3, 4):
            self.request(client, request_id)
        frame = client.recv_frame()
        self.assertEqual((frame["id"], frame["error"]["code"]), (4, "busy"))
        self.assertEqual(frame["error"]["details"]["reason"], "inflight")
        self.drain_until(3)
        for _ in range(3):
            client.recv_frame()
        self.request(client, 5)
        self.drain_until()
        self.assertTrue(client.recv_frame()["ok"])

    def test_queue_cap(self):
        self.start(queue_max=2)
        client = self.ready()
        for request_id in (1, 2, 3):
            self.request(client, request_id)
        frame = client.recv_frame()
        self.assertEqual((frame["id"], frame["error"]["code"]), (3, "busy"))
        self.assertEqual(frame["error"]["details"]["reason"], "queue_full")
        self.drain_until(2)

    def test_stalled_reader_is_dropped_after_send_timeout(self):
        self.start(send_timeout=0.4)
        client = self.ready()
        client.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        for request_id in range(1, 5):
            self.request(client, request_id, "big", {"n": 900000})
        self.drain_until(4)
        # The client never reads: the server must give up instead of blocking its thread.
        self.assertTrue(self.conn_closed(timeout=4.0))


if __name__ == "__main__":
    unittest.main()
