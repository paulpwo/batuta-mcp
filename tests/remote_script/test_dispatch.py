import queue
import unittest

from remote_script.BatutaMCP import validator as v
from remote_script.BatutaMCP.core_commands import install as install_core
from remote_script.BatutaMCP.dispatcher import Dispatcher, Job, MainThreadPump
from remote_script.BatutaMCP.errors import BatutaError
from remote_script.BatutaMCP.registry import Command, CommandRegistry, RegistryError
from remote_script.BatutaMCP.state import ScriptState

from .fakes import FakeCInstance, FakeClock, FakeSong, FakeTrack


class Harness:
    """Registry with a handful of test commands plus the core ones."""

    def __init__(self, tracks=0, edition=None, clock=None):
        self.clock = clock or FakeClock()
        self.song = FakeSong(tracks=[FakeTrack("T%d" % i) for i in range(tracks)])
        self.cinstance = FakeCInstance(self.song)
        self.state = ScriptState()
        if edition:
            self.state.set_edition(edition, "detected")
        self.calls = []
        self.registry = CommandRegistry()
        install_core(self.registry, "0.1.0")
        self._install_test_commands()
        self.registry.freeze()
        self.dispatcher = Dispatcher(self.registry, self.cinstance, self.state,
                                     clock=self.clock, log=self.cinstance.log_message)

    def _install_test_commands(self):
        song, calls, clock = self.song, self.calls, self.clock

        def echo(ctx, args):
            calls.append("echo")
            return {"v": args["v"]}

        def mutate(ctx, args):
            song.events.append("handler")
            return {}

        def boom(ctx, args):
            song.events.append("handler")
            ctx.note_mutation()
            raise RuntimeError("kaboom")

        def boom_clean(ctx, args):
            raise RuntimeError("Maximum number of tracks reached")

        def typed(ctx, args):
            raise BatutaError("not_found", "no such thing", {"what": "track", "index": 9})

        def grow(ctx, args):
            song.events.append("handler")
            song.tracks.append(FakeTrack("new"))
            return {}

        def count(ctx, args):
            return {"tracks": len(ctx.song.tracks)}

        def slow(ctx, args):
            calls.append("slow")
            clock.advance(0.01)
            return {}

        def unserializable(ctx, args):
            return {"x": object()}

        reg = self.registry.register
        reg(Command("echo", v.obj({"v": v.integer()}, required=["v"]), echo))
        reg(Command("mutate", v.obj({}), mutate, mutating=True))
        reg(Command("boom", v.obj({}), boom, mutating=True))
        reg(Command("boom_clean", v.obj({}), boom_clean, mutating=True))
        reg(Command("typed", v.obj({}), typed))
        reg(Command("grow", v.obj({}), grow, mutating=True,
                    edition_delta=lambda args: {"tracks": 1}))
        reg(Command("count", v.obj({}), count))
        reg(Command("slow", v.obj({}), slow))
        reg(Command("raw_mut", v.obj({}), mutate, mutating=True, undo_wrapped=False,
                    destructive="always"))
        reg(Command("flags", v.obj({}), lambda ctx, args: dict(ctx.flags)))
        reg(Command("big", v.obj({"n": v.with_default(v.integer(), 1100000)}),
                    lambda ctx, args: {"s": "x" * args["n"]}))
        reg(Command("unser", v.obj({}), unserializable))
        reg(Command("cond", v.obj({}), echo, destructive="conditional",
                    conditions=("allow_overwrite",)))

    def job(self, name, args=None, deadline=None, request_id=1, conn_id=1):
        command, normalized = self.registry.prepare_call(name, args or {})
        return Job(conn_id=conn_id, request_id=request_id, command=command,
                   args=normalized,
                   deadline=self.clock() + 5 if deadline is None else deadline,
                   flags={})

    def run(self, name, args=None, **kwargs):
        return self.dispatcher.execute(self.job(name, args, **kwargs))


class RegistryTests(unittest.TestCase):
    def test_allowlist_rejects_unknown_and_dangerous_names(self):
        h = Harness()
        for name in ("os.system", "getattr", "__class__", "__init__", "ECHO", "echo ", "", "eval"):
            self.assertIsNone(h.registry.get(name), name)
            with self.assertRaises(BatutaError) as ctx:
                h.registry.prepare_call(name, {})
            self.assertEqual(ctx.exception.code, "unknown_command")
            self.assertEqual(ctx.exception.details["cmd"], name)

    def test_non_string_name_is_unknown(self):
        h = Harness()
        with self.assertRaises(BatutaError):
            h.registry.prepare_call(["echo"], {})

    def test_duplicate_and_late_registration_refused(self):
        h = Harness()
        with self.assertRaises(RegistryError):
            h.registry.register(Command("echo", v.obj({}), lambda c, a: {}))
        fresh = CommandRegistry()
        fresh.register(Command("a", v.obj({}), lambda c, a: {}))
        fresh.freeze()
        with self.assertRaises(RegistryError):
            fresh.register(Command("b", v.obj({}), lambda c, a: {}))

    def test_bad_command_names_refused(self):
        with self.assertRaises(RegistryError):
            CommandRegistry().register(Command("Bad Name", v.obj({}), lambda c, a: {}))

    def test_schema_is_enforced_before_the_handler(self):
        h = Harness()
        for args in ({}, {"v": "x"}, {"v": True}, {"v": 1, "extra": 1}):
            with self.assertRaises(BatutaError) as ctx:
                h.registry.prepare_call("echo", args)
            self.assertEqual(ctx.exception.code, "invalid_args")
        self.assertEqual(h.calls, [])

    def test_catalog_lists_commands_with_classification(self):
        h = Harness()
        result = h.run("catalog")["result"]
        self.assertEqual(result["script_version"], "0.1.0")
        entries = {c["name"]: c for c in result["commands"]}
        self.assertEqual(entries["echo"], {"name": "echo", "mutating": False,
                                           "destructive": "never", "conditions": []})
        self.assertEqual(entries["raw_mut"]["destructive"], "always")
        self.assertEqual(entries["cond"]["conditions"], ["allow_overwrite"])
        self.assertTrue(entries["mutate"]["mutating"])
        self.assertIn("batch", entries)
        self.assertIn("catalog", entries)


class DispatcherTests(unittest.TestCase):
    def test_success_response_shape(self):
        h = Harness()
        self.assertEqual(h.run("echo", {"v": 7}, request_id=42),
                         {"id": 42, "ok": True, "result": {"v": 7}})

    def test_typed_errors_pass_through(self):
        h = Harness()
        response = h.run("typed")
        self.assertEqual(response["ok"], False)
        self.assertEqual(response["error"]["code"], "not_found")
        self.assertEqual(response["error"]["details"], {"what": "track", "index": 9})

    def test_unexpected_exception_maps_to_lom_error_with_partial_flag(self):
        h = Harness()
        error = h.run("boom")["error"]
        self.assertEqual(error["code"], "lom_error")
        self.assertEqual(error["message"], "kaboom")
        self.assertEqual(error["details"]["exception"], "RuntimeError")
        self.assertIs(error["details"]["partial"], True)
        clean = h.run("boom_clean")["error"]
        self.assertIs(clean["details"]["partial"], False)

    def test_error_message_is_length_capped_and_control_stripped(self):
        h = Harness()
        h.registry._commands["typed"] = Command(
            "typed", v.obj({}), lambda c, a: (_ for _ in ()).throw(RuntimeError("x\x00y" * 500)))
        message = h.run("typed")["error"]["message"]
        self.assertLessEqual(len(message), 300)
        self.assertNotIn("\x00", message)

    def test_edition_limit_hint_only_when_edition_unknown(self):
        h = Harness()
        self.assertEqual(h.run("boom_clean")["error"]["details"]["suspected"], "edition_limit")
        h2 = Harness(edition="suite")
        self.assertNotIn("suspected", h2.run("boom_clean")["error"]["details"])

    def test_mutation_is_wrapped_in_exactly_one_undo_step(self):
        h = Harness()
        h.run("mutate")
        self.assertEqual(h.song.events, ["begin", "handler", "end"])

    def test_undo_step_closes_when_handler_raises(self):
        h = Harness()
        h.run("boom")
        self.assertEqual(h.song.events, ["begin", "handler", "end"])

    def test_undo_step_closes_on_every_exception_type(self):
        h = Harness()
        for exc in (ValueError("x"), KeyError("k"), BatutaError("not_found", "m"), RuntimeError()):
            h.song.events.clear()

            def raiser(ctx, args, exc=exc):
                raise exc

            h.registry._commands["mutate"] = Command("mutate", v.obj({}), raiser, mutating=True)
            h.run("mutate")
            self.assertEqual(h.song.events, ["begin", "end"], repr(exc))

    def test_validation_failure_never_opens_an_undo_step(self):
        h = Harness()
        with self.assertRaises(BatutaError):
            h.registry.prepare_call("mutate", {"nope": 1})
        self.assertEqual(h.song.events, [])

    def test_read_only_command_opens_no_undo_step(self):
        h = Harness()
        h.run("echo", {"v": 1})
        h.run("count")
        self.assertEqual(h.song.events, [])

    def test_undo_wrapped_false_skips_the_wrapper(self):
        h = Harness()
        h.run("raw_mut")
        self.assertEqual(h.song.events, ["handler"])

    def test_expired_job_is_not_started(self):
        h = Harness()
        response = h.run("echo", {"v": 1}, deadline=h.clock() - 0.001)
        self.assertEqual(response["error"]["code"], "timeout")
        self.assertEqual(response["error"]["details"]["stage"], "queue")
        self.assertEqual(h.calls, [])

    def test_connection_change_resets_per_connection_state(self):
        h = Harness()
        h.state.remember_uri("u", {"x": 1})
        h.state.ears_track = object()
        h.run("echo", {"v": 1}, conn_id=1)
        h.state.remember_uri("u2", {"x": 2})
        h.run("echo", {"v": 1}, conn_id=1)
        self.assertEqual(h.state.lookup_uri("u2"), {"x": 2})
        h.run("echo", {"v": 1}, conn_id=2)
        self.assertIsNone(h.state.lookup_uri("u2"))
        self.assertIsNone(h.state.ears_track)

    def test_uri_map_is_lru_bounded(self):
        state = ScriptState()
        for index in range(5001):
            state.remember_uri("u%d" % index, index)
        self.assertIsNone(state.lookup_uri("u0"))
        self.assertEqual(state.lookup_uri("u5000"), 5000)


class PumpTests(unittest.TestCase):
    def make(self, live=True):
        h = Harness()
        inbound = queue.Queue(maxsize=64)
        posted = []
        pump = MainThreadPump(inbound, h.dispatcher, lambda cid, frame: posted.append((cid, frame)),
                              lambda cid: live, clock=h.clock, budget=0.020)
        return h, inbound, posted, pump

    def test_nothing_runs_until_drain(self):
        h, inbound, posted, pump = self.make()
        inbound.put(h.job("echo", {"v": 1}))
        self.assertEqual(posted, [])
        self.assertEqual(h.calls, [])
        self.assertEqual(pump.drain(), 1)
        self.assertEqual(posted[0][1]["result"], {"v": 1})
        self.assertEqual(posted[0][0], 1)

    def test_fifo_order(self):
        h, inbound, posted, pump = self.make()
        for index in range(5):
            inbound.put(h.job("echo", {"v": index}, request_id=index))
        pump.drain()
        self.assertEqual([frame["id"] for _, frame in posted], [0, 1, 2, 3, 4])

    def test_budget_limits_work_per_tick(self):
        h, inbound, posted, pump = self.make()
        for index in range(6):
            inbound.put(h.job("slow", request_id=index))
        self.assertEqual(pump.drain(), 2)  # 10 ms each, 20 ms budget
        self.assertEqual(inbound.qsize(), 4)
        self.assertEqual(pump.drain(), 2)
        self.assertEqual(pump.drain(), 2)
        self.assertEqual(pump.drain(), 0)

    def test_at_least_one_item_even_with_zero_budget(self):
        h, inbound, posted, pump = self.make()
        pump.budget = 0.0
        for index in range(3):
            inbound.put(h.job("slow", request_id=index))
        self.assertEqual(pump.drain(), 1)

    def test_jobs_of_dead_connections_are_discarded_unexecuted(self):
        h, inbound, posted, pump = self.make(live=False)
        inbound.put(h.job("mutate"))
        pump.drain()
        self.assertEqual(h.song.events, [])
        self.assertEqual(posted, [])

    def test_empty_queue_is_fine(self):
        h, inbound, posted, pump = self.make()
        self.assertEqual(pump.drain(), 0)


class BatchTests(unittest.TestCase):
    def batch(self, h, ops, **extra):
        args = {"ops": [{"cmd": c, "args": a} for c, a in ops]}
        args.update(extra)
        return h.run("batch", args)

    def assertRejected(self, h, ops, code, **extra):
        with self.assertRaises(BatutaError) as ctx:
            args = {"ops": [{"cmd": c, "args": a} for c, a in ops]}
            args.update(extra)
            h.registry.prepare_call("batch", args)
        self.assertEqual(ctx.exception.code, code)
        return ctx.exception

    def test_all_ops_succeed_with_a_single_undo_pair(self):
        h = Harness()
        response = self.batch(h, [("mutate", {}), ("echo", {"v": 5}), ("mutate", {}), ("mutate", {})])
        result = response["result"]
        self.assertEqual(result["executed"], 4)
        self.assertIs(result["partial"], False)
        self.assertEqual(result["results"][1], {"ok": True, "result": {"v": 5}})
        self.assertEqual(h.song.events, ["begin", "handler", "handler", "handler", "end"])

    def test_read_only_batch_opens_no_undo_step(self):
        h = Harness()
        self.batch(h, [("echo", {"v": 1}), ("count", {})])
        self.assertEqual(h.song.events, [])

    def test_stop_on_error_default_gives_partial_results(self):
        h = Harness()
        result = self.batch(h, [("mutate", {}), ("typed", {}), ("mutate", {})])["result"]
        self.assertEqual(result["executed"], 2)
        self.assertIs(result["partial"], True)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["results"][1]["error"]["code"], "not_found")
        self.assertEqual(h.song.events, ["begin", "handler", "end"])

    def test_first_op_failure_without_mutation_is_not_partial(self):
        h = Harness()
        result = self.batch(h, [("typed", {}), ("mutate", {})])["result"]
        self.assertEqual(result["executed"], 1)
        self.assertIs(result["partial"], False)

    def test_continue_on_error(self):
        h = Harness()
        result = self.batch(h, [("typed", {}), ("mutate", {}), ("boom", {})],
                            stop_on_error=False)["result"]
        self.assertEqual(result["executed"], 3)
        self.assertIs(result["partial"], False)
        self.assertEqual([r["ok"] for r in result["results"]], [False, True, False])
        self.assertEqual(result["results"][2]["error"]["code"], "lom_error")
        self.assertEqual(h.song.events.count("begin"), 1)
        self.assertEqual(h.song.events.count("end"), 1)

    def test_op_exception_partial_is_reported_in_the_op_error(self):
        h = Harness()
        result = self.batch(h, [("boom", {}), ("mutate", {})])["result"]
        self.assertIs(result["results"][0]["error"]["details"]["partial"], True)
        self.assertIs(result["partial"], True)

    def test_references_are_resolved_per_op_at_execution_time(self):
        h = Harness(tracks=2)
        result = self.batch(h, [("count", {}), ("grow", {}), ("count", {})])["result"]
        self.assertEqual(result["results"][0]["result"]["tracks"], 2)
        self.assertEqual(result["results"][2]["result"]["tracks"], 3)

    def test_static_validation_rejects_the_whole_batch_before_anything_runs(self):
        h = Harness()
        self.assertRejected(h, [("mutate", {}), ("echo", {"v": "bad"})], "invalid_args")
        self.assertRejected(h, [("mutate", {}), ("nope", {})], "unknown_command")
        self.assertRejected(h, [("mutate", {}), ("mutate", {"zzz": 1})], "invalid_args")
        self.assertEqual(h.song.events, [])
        self.assertEqual(h.calls, [])

    def test_forbidden_commands_in_ops(self):
        h = Harness()
        for name in ("batch", "catalog", "undo", "redo", "browser_search"):
            error = self.assertRejected(h, [(name, {})], "invalid_args")
            self.assertEqual(error.details["reason"], "forbidden_in_batch")

    def test_op_count_bounds(self):
        h = Harness()
        self.assertRejected(h, [], "invalid_args")
        self.assertRejected(h, [("echo", {"v": 1})] * 33, "invalid_args")
        h.registry.prepare_call("batch", {"ops": [{"cmd": "echo", "args": {"v": 1}}] * 32})

    def test_op_shape_is_strict(self):
        h = Harness()
        for bad in ({"cmd": "echo"}, {"args": {}}, {"cmd": "echo", "args": {"v": 1}, "x": 1},
                    {"cmd": 5, "args": {}}, {"cmd": "echo", "args": []}):
            with self.assertRaises(BatutaError):
                h.registry.prepare_call("batch", {"ops": [bad]})

    def test_projected_edition_counts_reject_before_running(self):
        h = Harness(tracks=7, edition="lite")
        response = self.batch(h, [("grow", {}), ("grow", {})])
        self.assertEqual(response["error"]["code"], "edition_limit")
        self.assertEqual(response["error"]["details"]["op_index"], 1)
        self.assertEqual(response["error"]["details"]["resource"], "tracks")
        self.assertEqual(len(h.song.tracks), 7)
        self.assertEqual(h.song.events, [])  # rejected before any undo step is opened

    def test_projection_allows_filling_to_the_limit(self):
        h = Harness(tracks=6, edition="lite")
        result = self.batch(h, [("grow", {}), ("grow", {})])["result"]
        self.assertEqual(result["executed"], 2)
        self.assertEqual(len(h.song.tracks), 8)

    def test_projection_is_skipped_when_edition_unknown(self):
        h = Harness(tracks=7)
        result = self.batch(h, [("grow", {}), ("grow", {})])["result"]
        self.assertEqual(result["executed"], 2)

    def test_batch_default_timeout_is_longer(self):
        h = Harness()
        self.assertEqual(h.registry.get("batch").default_timeout_ms, 10000)
        self.assertEqual(h.registry.get("echo").default_timeout_ms, 5000)

    def test_batch_mutability_depends_on_ops(self):
        h = Harness()
        command = h.registry.get("batch")
        _, read_only = h.registry.prepare_call("batch", {"ops": [{"cmd": "echo", "args": {"v": 1}}]})
        _, writes = h.registry.prepare_call("batch", {"ops": [{"cmd": "echo", "args": {"v": 1}},
                                                              {"cmd": "mutate", "args": {}}]})
        self.assertFalse(command.is_mutating(read_only, h.registry))
        self.assertTrue(command.is_mutating(writes, h.registry))


if __name__ == "__main__":
    unittest.main()
