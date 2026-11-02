import os
import time
import unittest
from unittest import mock

from remote_script.BatutaMCP import BatutaScript, create_instance, limits, runtime_files

from . import fakes

REQUIRED_METHODS = (
    "update_display", "disconnect", "refresh_state", "build_midi_map", "receive_midi",
    "can_lock_to_devices", "connect_script_instances", "suggest_input_port",
    "suggest_output_port",
)


class ScriptTestCase(unittest.TestCase):
    version = "12.4.7 Lite"

    def setUp(self):
        fakes.install_fake_live(self.version)
        self.addCleanup(fakes.uninstall_fake_live)
        self.rt = fakes.short_tmpdir()
        self.addCleanup(fakes.remove_tree, self.rt)
        self.ci = fakes.FakeCInstance()
        self.scripts = []
        self.clients = []
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for client in self.clients:
            client.close()
        for script in self.scripts:
            script.disconnect()

    def make(self, runtime_dir=None, **kwargs):
        script = BatutaScript(self.ci, runtime_dir=runtime_dir or self.rt, **kwargs)
        self.scripts.append(script)
        return script

    @property
    def sock_path(self):
        return os.path.join(self.rt, "live.sock")

    def token(self):
        with open(os.path.join(self.rt, "token")) as handle:
            return handle.read()

    def connect(self, **hello):
        client = fakes.WireClient(self.sock_path)
        self.clients.append(client)
        welcome = client.handshake(self.token(), **hello)
        return client, welcome

    def call(self, script, client, request_id, cmd, args=None):
        client.send_frame({"id": request_id, "cmd": cmd, "args": args or {}})
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            script.update_display()
            client.sock.settimeout(0.05)
            try:
                return client.recv_frame()
            except Exception:
                continue
        raise AssertionError("no response")


class ControlSurfaceContractTests(ScriptTestCase):
    def test_create_instance_exposes_the_required_methods(self):
        with mock.patch.dict(os.environ, {"HOME": self.rt}):
            os.makedirs(os.path.join(self.rt, "Library", "Application Support"))
            script = create_instance(self.ci)
            self.scripts.append(script)
        for name in REQUIRED_METHODS:
            self.assertTrue(callable(getattr(script, name)), name)
        runtime = os.path.join(self.rt, "Library", "Application Support", "BatutaMCP")
        self.assertEqual(fakes.mode_of(runtime), 0o700)
        self.assertEqual(fakes.mode_of(os.path.join(runtime, "token")), 0o600)
        self.assertEqual(fakes.mode_of(os.path.join(runtime, "live.sock")), 0o600)

    def test_trivial_methods_are_harmless(self):
        script = self.make()
        script.refresh_state()
        script.build_midi_map(123)
        script.receive_midi((144, 60, 100))
        script.connect_script_instances([])
        self.assertFalse(script.can_lock_to_devices())
        self.assertIsInstance(script.suggest_input_port(), str)
        self.assertIsInstance(script.suggest_output_port(), str)
        script.update_display()


class StartupTests(ScriptTestCase):
    def test_startup_creates_token_and_socket_with_safe_modes(self):
        self.make()
        self.assertEqual(fakes.mode_of(os.path.join(self.rt, "token")), 0o600)
        self.assertEqual(fakes.mode_of(self.sock_path), 0o600)
        self.assertRegex(self.token(), r"^[0-9a-f]{64}$")

    def test_refusal_logs_one_line_and_never_listens(self):
        os.chmod(self.rt, 0o755)
        script = self.make()
        self.assertEqual(len(self.ci.logs), 1)
        self.assertFalse(os.path.exists(self.sock_path))
        script.update_display()
        script.disconnect()
        self.assertEqual(os.listdir(self.rt), [])

    def test_second_instance_refuses_and_does_not_disturb_the_first(self):
        first = self.make()
        second = self.make()
        self.assertTrue(any("refus" in line.lower() for line in self.ci.logs))
        second.disconnect()
        self.assertTrue(os.path.exists(self.sock_path))  # not unlinked by the loser
        time.sleep(0.3)  # let the live script accept and discard the loser's liveness probe
        client, welcome = self.connect()
        self.assertEqual(welcome["type"], "welcome")
        first.update_display()

    def test_token_never_reaches_the_log(self):
        self.make()
        client = fakes.WireClient(self.sock_path)
        self.clients.append(client)
        client.send_frame({"type": "hello", "protocol": 1, "token": "0" * 64})
        client.expect_closed()
        client2, _ = self.connect()
        client2.close()
        time.sleep(0.2)
        self.assertNotIn(self.token(), "\n".join(self.ci.logs))


class HandshakeAndWelcomeTests(ScriptTestCase):
    def test_welcome_frame(self):
        self.make()
        _, welcome = self.connect()
        self.assertEqual(welcome, {
            "type": "welcome", "protocol": 1, "live_version": "12.4.7",
            "script_version": runtime_files.SCRIPT_VERSION, "edition": "lite", "edition_source": "detected",
            "max_frame": 1048576,
            "limits": {"max_inflight": 16, "rate_per_s": 50, "burst": 100},
        })

    def test_detection_wins_over_hint(self):
        script = self.make()
        _, welcome = self.connect(edition_hint="suite")
        self.assertEqual((welcome["edition"], welcome["edition_source"]), ("lite", "detected"))
        self.assertEqual(script.state.edition, "lite")


class UnknownEditionTests(ScriptTestCase):
    version = "12.4.3"

    def test_hint_used_when_detection_fails(self):
        script = self.make()
        _, welcome = self.connect(edition_hint="suite")
        self.assertEqual((welcome["edition"], welcome["edition_source"]), ("suite", "hint"))
        self.assertEqual(script.state.edition, "suite")

    def test_unknown_without_hint(self):
        self.make()
        _, welcome = self.connect()
        self.assertEqual((welcome["edition"], welcome["edition_source"]), ("unknown", "none"))


class ExecutionTests(ScriptTestCase):
    def test_requests_are_only_served_from_update_display(self):
        script = self.make()
        client, _ = self.connect()
        client.send_frame({"id": 1, "cmd": "catalog", "args": {}})
        client.sock.settimeout(0.4)
        with self.assertRaises(Exception):
            client.recv_frame()
        deadline = time.monotonic() + 3
        response = None
        while response is None and time.monotonic() < deadline:
            script.update_display()
            client.sock.settimeout(0.05)
            try:
                response = client.recv_frame()
            except Exception:
                pass
        self.assertTrue(response["ok"])
        names = {c["name"] for c in response["result"]["commands"]}
        self.assertIn("catalog", names)
        self.assertIn("batch", names)

    def test_unknown_command_over_the_wire(self):
        script = self.make()
        client, _ = self.connect()
        client.send_frame({"id": 2, "cmd": "save_set", "args": {}})
        client.sock.settimeout(3)
        self.assertEqual(client.recv_frame()["error"]["code"], "unknown_command")

    def test_batch_framework_runs_through_the_wire(self):
        script = self.make()
        client, _ = self.connect()
        response = self.call(script, client, 3, "batch", {"ops": [{"cmd": "catalog", "args": {}}]})
        self.assertEqual(response["error"]["code"], "invalid_args")  # catalog is forbidden in batch

    def test_update_display_never_raises_into_live(self):
        script = self.make()
        with mock.patch.object(script._pump, "drain", side_effect=RuntimeError("boom")):
            script.update_display()
        self.assertTrue(any("boom" in line for line in self.ci.logs))

    def test_log_function_failures_do_not_escape(self):
        self.ci.log_message = mock.Mock(side_effect=RuntimeError("log broke"))
        script = self.make()
        script.update_display()


class DisconnectTests(ScriptTestCase):
    def test_disconnect_closes_everything_and_keeps_the_token(self):
        script = self.make()
        client, _ = self.connect()
        script.disconnect()
        client.expect_closed()
        self.assertFalse(os.path.exists(self.sock_path))
        self.assertTrue(os.path.exists(os.path.join(self.rt, "token")))
        self.assertEqual(os.listdir(self.rt), ["token"])
        self.assertFalse(script.is_listening)

    def test_disconnect_is_idempotent_and_update_display_afterwards_is_inert(self):
        script = self.make()
        script.disconnect()
        script.disconnect()
        script.update_display()

    def test_disconnect_clears_state_and_drops_queued_work(self):
        script = self.make()
        client, _ = self.connect()
        script.state.ears_track = object()
        client.send_frame({"id": 1, "cmd": "catalog", "args": {}})
        time.sleep(0.2)
        script.disconnect()
        self.assertIsNone(script.state.ears_track)
        script.update_display()  # nothing is executed or posted any more

    def test_socket_thread_stops(self):
        script = self.make()
        thread = script._server._thread
        script.disconnect()
        self.assertFalse(thread.is_alive())

    def test_restart_after_disconnect_reuses_token(self):
        first = self.make()
        token = self.token()
        first.disconnect()
        self.make()
        self.assertEqual(self.token(), token)
        self.connect()


if __name__ == "__main__":
    unittest.main()
