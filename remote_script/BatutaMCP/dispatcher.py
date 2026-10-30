"""Main-thread execution: jobs, the dispatcher and the update_display pump (spec sections 5.1-5.4)."""

import queue
import time
from dataclasses import dataclass, field
from typing import Any

from . import limits, status_message
from .context import HandlerContext
from .errors import BatutaError, from_exception


# A resumable handler yields this to say "continue on the next update_display tick, not later in this
# one". Live applies some writes (playhead, play state) only on its next tick, so a command that must
# see the effect of a write waits one tick with it. A plain `yield` just lets the slice budget decide.
NEXT_TICK = object()

# Commands that add tracks or devices by themselves (a batch counts when any op is one).
_CONTENT_COMMANDS = frozenset(["track_create", "track_duplicate", "device_insert", "browser_load",
                               "drum_pad_copy"])


def _adds_content(command, args):
    if command.name in _CONTENT_COMMANDS:
        return True
    return command.name == "batch" and any(op["cmd"] in _CONTENT_COMMANDS for op in args["ops"])


@dataclass
class Job:
    """A validated request waiting for the main thread."""

    conn_id: int
    request_id: int
    command: Any
    args: dict
    deadline: float
    flags: dict = field(default_factory=dict)


def ok_response(request_id, result):
    return {"id": request_id, "ok": True, "result": result}


def error_response(request_id, error):
    return {"id": request_id, "ok": False, "error": error.to_wire()}


class RunningJob:
    """A resumable handler (a generator) suspended between ticks; created by `Dispatcher.start`."""

    def __init__(self, job, generator, ctx=None):
        self.job = job
        self._generator = generator
        self.ctx = ctx

    def close(self):
        self._generator.close()


class Dispatcher:
    """Runs one job: deadline check, undo wrapper, handler, error mapping."""

    def __init__(self, registry, c_instance, state, clock=time.monotonic, log=None, between_ticks=None):
        self._registry = registry
        self._between_ticks = between_ticks  # synchronous `execute` only: stands in for Live's tick
        self._c_instance = c_instance
        self._state = state
        self._clock = clock
        self._log = log or (lambda message: None)
        self._status_failure_logged = False

    def execute(self, job):
        """Always returns a response frame; never raises. A resumable command runs to completion.

        Without a live tick source (tests) a NEXT_TICK wait calls `between_ticks`, when one is given."""
        outcome = self.start(job)
        while isinstance(outcome, RunningJob):
            response = self.resume(outcome, None)
            if response is None and self._between_ticks is not None:
                self._between_ticks()
            outcome = response if response is not None else outcome
        return outcome

    def start(self, job):
        """Run `job` now: a response frame, or a `RunningJob` when a resumable handler suspended."""
        ctx = None
        try:
            if self._clock() > job.deadline:
                raise BatutaError("timeout", "request expired before it started", {"stage": "queue"})
            self._state.bind_connection(job.conn_id)
            ctx = HandlerContext(self._c_instance, self._state, self._registry, job.flags, self._log)
            ctx.command_name = job.command.name  # handlers that must wait for ticks run only top level
            if job.command.resumable:
                if job.command.precheck is not None:
                    job.command.precheck(ctx, job.args)
                return RunningJob(job, job.command.handler(ctx, job.args))
            result = self._run_tracking_sweeps(ctx, job)
            if hasattr(result, "send") and hasattr(result, "throw"):  # a generator
                # A mutating command that waits for Live's ticks. It opens its own undo steps.
                return RunningJob(job, result, ctx)
            response = ok_response(job.request_id, result)
            self._show_status(job, None)  # after the undo step closed
            return response
        except Exception as exc:  # every handler failure becomes a typed protocol error
            return self._failure(job, exc, ctx)

    def resume(self, running, slice_s):
        """Step a suspended handler for up to `slice_s` seconds (None: until done or NEXT_TICK).

        Returns the response frame when the handler finished, failed or ran out of time, else None."""
        job = running.job
        began = self._clock()
        try:
            while True:
                if self._clock() > job.deadline:
                    running.close()
                    if running.ctx is None:
                        raise BatutaError("timeout", "the search ran out of time", {"stage": "search"})
                    raise BatutaError("timeout", "the command ran out of time",
                                      {"stage": "tick", "partial": running.ctx.mutated})
                try:
                    signal = next(running._generator)
                except StopIteration as done:
                    self._show_status(job, None)  # after the last undo step closed
                    return ok_response(job.request_id, done.value)
                if signal is NEXT_TICK:
                    return None  # the rest of this handler belongs to the next tick
                if slice_s is not None and self._clock() - began >= slice_s:
                    return None
        except Exception as exc:
            running.close()
            return self._failure(job, exc, running.ctx)

    def _run_tracking_sweeps(self, ctx, job):
        """Run the job; when it adds tracks or devices itself, pending sweeps absorb that afterwards
        (the script knows its own mutations, a sweep must never mistake them for a load's)."""
        sweeps = list(self._state.sweeps) if _adds_content(job.command, job.args) else []
        try:
            return self._run(ctx, job.command, job.args)
        finally:
            for sweep in sweeps:
                sweep.rebaseline(ctx.song)

    def tick_sweeps(self):
        """One update_display tick for every pending post-load sweep (see sweep.py)."""
        state = self._state
        for sweep in list(state.sweeps):
            outcome = sweep.step(self._c_instance.song(), self._log)
            if outcome is not None:
                state.sweeps.remove(sweep)
                state.record_sweep(outcome)

    def cancel_sweeps(self):
        count = len(self._state.sweeps)
        del self._state.sweeps[:]
        if count:
            self._log("sweeps cancelled: %d" % count)

    def _failure(self, job, exc, ctx):
        error = from_exception(exc, partial=bool(ctx and ctx.mutated),
                               edition_unknown=self._state.edition == "unknown")
        if not isinstance(exc, BatutaError):
            self._log("handler %s failed: %s: %s" % (job.command.name, type(exc).__name__, error.message))
        self._show_status(job, error)
        return error_response(job.request_id, error)

    def _show_status(self, job, error):
        """One status bar line for a mutating command; read-only commands stay silent and a
        failure here never touches the command's outcome."""
        try:
            command = job.command
            if not command.is_mutating(job.args, self._registry):
                return
            if error is None:
                line = status_message.success_line(command, job.args)
            else:
                line = status_message.refusal_line(command, error)
            self._c_instance.show_message(line)
        except Exception as exc:  # the status bar is cosmetic
            if not self._status_failure_logged:
                self._status_failure_logged = True
                self._log("status message failed: %s" % type(exc).__name__)

    @staticmethod
    def _run(ctx, command, args):
        """Validate first, then exactly one begin/end undo pair around a mutating command (5.3)."""
        if command.precheck is not None:
            command.precheck(ctx, args)  # may reject; no undo step exists yet
        if command.is_mutating(args, ctx.registry) and command.undo_wrapped:
            ctx.song.begin_undo_step()
            try:
                return command.handler(ctx, args)
            finally:
                ctx.song.end_undo_step()
        return command.handler(ctx, args)


class MainThreadPump:
    """Drains the inbound queue; called from update_display only (never from the socket thread)."""

    def __init__(self, inbound, dispatcher, post, is_live, clock=time.monotonic,
                 budget=limits.DRAIN_BUDGET_S):
        self._inbound = inbound
        self._dispatcher = dispatcher
        self._post = post
        self._is_live = is_live
        self._clock = clock
        self.budget = budget
        self._active = None  # the RunningJob at the head of the line, if any

    def drain(self):
        """Start jobs until the time budget is spent, always running at least one. Returns the count.

        A resumable job (browser_search) takes the head of the line: it gets one slice per tick and
        everything queued behind it waits, so responses keep their order."""
        started = self._clock()
        executed = 0
        self._dispatcher.tick_sweeps()
        if self._active is not None:
            if not self._is_live(self._active.job.conn_id):
                self._drop_active()
            else:
                self._advance_active()
                if self._active is not None:
                    return 1  # still searching: this tick's slice is spent
                executed = 1
        while True:
            if executed >= 1 and self._clock() - started >= self.budget:
                break
            try:
                job = self._inbound.get_nowait()
            except queue.Empty:
                break
            if not self._is_live(job.conn_id):
                continue  # the client is gone: never run its queued work
            outcome = self._dispatcher.start(job)
            executed += 1
            if isinstance(outcome, RunningJob):
                self._active = outcome
                self._advance_active()
                if self._active is not None:
                    break  # suspended: later jobs wait behind it
                continue
            self._post(job.conn_id, outcome)
        return executed

    def _advance_active(self):
        running = self._active
        response = self._dispatcher.resume(running, limits.SEARCH_SLICE_S)
        if response is not None:
            self._active = None
            self._post(running.job.conn_id, response)

    def _drop_active(self):
        running, self._active = self._active, None
        running.close()

    def discard_pending(self):
        """Drop everything still queued and any suspended search (used by disconnect)."""
        if self._active is not None:
            self._drop_active()
        self._dispatcher.cancel_sweeps()
        while True:
            try:
                self._inbound.get_nowait()
            except queue.Empty:
                return
