"""Resumable handlers (docs/01-protocol.md section 5.1): a generator command is resumed each tick for
up to 15 ms and answers when it finishes; other jobs wait behind it so responses stay in order."""

import queue
import unittest

from remote_script.BatutaMCP import limits
from remote_script.BatutaMCP import validator as v
from remote_script.BatutaMCP.dispatcher import Dispatcher, Job, MainThreadPump
from remote_script.BatutaMCP.registry import Command, CommandRegistry, RegistryError
from remote_script.BatutaMCP.state import ScriptState

from .fakes import FakeCInstance, FakeClock, FakeSong


STEP = 0.0078125  # 2 ** -7 seconds: exact in binary, so two steps fill the 15 ms slice


class World:
    def __init__(self):
        self.clock = FakeClock()
        self.closed = []
        self.steps = 0
        self.registry = CommandRegistry()
        reg = self.registry.register
        reg(Command("walk", v.obj({"n": v.integer(), "cost": v.with_default(v.number(), STEP),
                                   "boom_at": v.integer()}), self._walk, resumable=True))
        reg(Command("echo", v.obj({}), lambda ctx, args: {"echo": True}))
        self.registry.freeze()
        self.dispatcher = Dispatcher(self.registry, FakeCInstance(FakeSong()), ScriptState(),
                                     clock=self.clock)

    def _walk(self, ctx, args):
        try:
            for step in range(args["n"]):
                if args.get("boom_at") == step:
                    raise RuntimeError("kaboom")
                self.steps += 1
                self.clock.advance(args["cost"])
                yield
            return {"steps": args["n"]}
        finally:
            self.closed.append(args["n"])

    def job(self, name, args=None, request_id=1, conn_id=1, timeout=15.0):
        command, normalized = self.registry.prepare_call(name, args or {})
        return Job(conn_id, request_id, command, normalized, self.clock() + timeout, {})

    def pump(self, live=True):
        inbound = queue.Queue(maxsize=64)
        posted = []
        pump = MainThreadPump(inbound, self.dispatcher, lambda cid, frame: posted.append((cid, frame)),
                              lambda cid: live if isinstance(live, bool) else live(cid), clock=self.clock)
        return inbound, posted, pump


class ResumableTests(unittest.TestCase):
    def test_limits(self):
        self.assertEqual(limits.SEARCH_SLICE_S, 0.015)
        self.assertEqual(limits.SEARCH_NODE_CAP, 3000)

    def test_execute_runs_a_resumable_command_to_completion(self):
        w = World()
        response = w.dispatcher.execute(w.job("walk", {"n": 10}))
        self.assertEqual(response["result"], {"steps": 10})
        self.assertEqual(w.closed, [10])

    def test_pump_resumes_across_ticks_within_the_slice(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 10}))
        pump.drain()
        self.assertEqual(posted, [])                 # still running
        self.assertEqual(w.steps, 2)                 # two steps of 7.8 ms fill the 15 ms slice
        pump.drain()
        self.assertEqual(w.steps, 4)
        self.drain_until(pump, posted, 1)
        self.assertEqual(w.steps, 10)
        self.assertEqual(posted[0][1]["result"], {"steps": 10})

    def drain_until(self, pump, posted, count):
        for _ in range(20):
            if len(posted) >= count:
                return
            pump.drain()
        self.fail("the search never finished")

    def test_every_tick_makes_progress_even_with_a_zero_slice(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 3, "cost": 0.5}))
        pump.drain()
        self.assertEqual(w.steps, 1)
        self.drain_until(pump, posted, 1)
        self.assertEqual(posted[0][1]["result"], {"steps": 3})

    def test_later_jobs_wait_so_responses_stay_in_order(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 10}, request_id=1))
        inbound.put(w.job("echo", request_id=2))
        pump.drain()
        self.assertEqual(posted, [])
        self.assertEqual(inbound.qsize(), 1)
        self.drain_until(pump, posted, 2)
        self.assertEqual([frame["id"] for _, frame in posted], [1, 2])

    def test_a_short_resumable_job_finishes_within_one_tick_and_the_queue_continues(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 1}, request_id=1))
        inbound.put(w.job("echo", request_id=2))
        pump.drain()
        self.assertEqual([frame["id"] for _, frame in posted], [1, 2])

    def test_a_dead_connection_abandons_the_search(self):
        w = World()
        alive = [True]
        inbound, posted, pump = w.pump(live=lambda cid: alive[0])
        inbound.put(w.job("walk", {"n": 10}))
        pump.drain()
        alive[0] = False
        pump.drain()
        self.assertEqual(posted, [])
        self.assertEqual(w.closed, [10])
        self.assertEqual(w.steps, 2)

    def test_the_deadline_ends_a_suspended_search_with_a_timeout(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 1000}, timeout=0.02))
        pump.drain()
        pump.drain()
        error = posted[0][1]["error"]
        self.assertEqual((error["code"], error["details"]["stage"]), ("timeout", "search"))
        self.assertEqual(w.closed, [1000])
        self.assertLess(w.steps, 20)

    def test_an_exception_mid_search_is_a_typed_error(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 10, "boom_at": 4}))
        for _ in range(3):
            pump.drain()
        frame = posted[0][1]
        self.assertEqual((frame["ok"], frame["error"]["code"]), (False, "lom_error"))
        self.assertEqual(w.closed, [10])

    def test_discard_pending_closes_the_running_generator(self):
        w = World()
        inbound, posted, pump = w.pump()
        inbound.put(w.job("walk", {"n": 10}))
        pump.drain()
        pump.discard_pending()
        self.assertEqual(w.closed, [10])
        self.assertEqual(pump.drain(), 0)

    def test_a_resumable_command_cannot_be_mutating(self):
        registry = CommandRegistry()
        with self.assertRaises(RegistryError):
            registry.register(Command("bad", v.obj({}), lambda ctx, args: iter(()), mutating=True,
                                      resumable=True))


if __name__ == "__main__":
    unittest.main()
