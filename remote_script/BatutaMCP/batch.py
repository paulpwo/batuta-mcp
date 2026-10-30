"""The `batch` executor framework (docs/01-protocol.md section 7.1).

Static validation of every op happens on the socket thread (`prepare_batch`). References inside ops
are resolved by the handlers at execution time, op by op. The whole batch is one command and
therefore one undo step; per-op results are collected so a failure leaves a readable partial result.
"""

from . import limits
from . import validator as v
from .errors import BatutaError, from_exception

FORBIDDEN_IN_BATCH = frozenset(["batch", "catalog", "undo", "redo", "browser_search"])

BATCH_SCHEMA = v.obj({
    "ops": v.array(v.obj({"cmd": v.string(max_chars=64), "args": v.free_object()},
                         required=["cmd", "args"]),
                   min_items=1, max_items=limits.MAX_BATCH_OPS),
    "stop_on_error": v.with_default(v.boolean(), True),
}, required=["ops"])


def prepare_batch(args, registry):
    """Validate every op against its own schema; returns args with normalized per-op args."""
    prepared = []
    for index, op in enumerate(args["ops"]):
        name = op["cmd"]
        if name in FORBIDDEN_IN_BATCH:
            raise BatutaError("invalid_args", "command not allowed inside batch",
                              {"reason": "forbidden_in_batch", "cmd": name, "op_index": index})
        try:
            _, normalized = registry.prepare_call(name, op["args"])
        except BatutaError as exc:
            if exc.details is None:
                exc.details = {}
            exc.details["op_index"] = index
            raise
        prepared.append({"cmd": name, "args": normalized})
    return {"ops": prepared, "stop_on_error": args["stop_on_error"]}


def batch_is_mutating(args, registry):
    return any(registry.get(op["cmd"]).is_mutating(op["args"], registry) for op in args["ops"])


def _ask_before_running(ctx, ops):
    """Refuse the whole batch up front when an op would need the owner's acknowledgement of a live
    external input, or the acknowledgement it carries no longer covers every external-live track
    (reported before any op runs). Other precheck failures are left to the ops: each op repeats its own
    guards when it runs. An op that only becomes acknowledgeable because an earlier op of the same batch
    changed the set is refused at that op (see `run_batch`)."""
    for op in ops:
        check = registry_precheck(ctx, op)
        if check is None:
            continue
        try:
            check(ctx, op["args"])
        except BatutaError as exc:
            if exc.details and exc.details.get("acknowledgeable") is True:
                raise
        except Exception:  # an op that cannot be pre-checked now is judged when it runs
            pass


def registry_precheck(ctx, op):
    command = ctx.registry.get(op["cmd"])
    return None if command is None else command.precheck


def precheck_batch(ctx, args):
    """Projected edition counts: refuse the whole batch before any undo step or op exists."""
    registry = ctx.registry
    _ask_before_running(ctx, args["ops"])
    deltas = []
    for op in args["ops"]:
        command = registry.get(op["cmd"])
        deltas.append(command.edition_delta(op["args"]) if command.edition_delta else None)
    if any(deltas):
        ctx.edition.check_projection(ctx.edition_counts(), deltas)


def _stop_asking_mid_batch(exc, ops_run):
    """An op that needs the owner's acknowledgement only because an earlier op of this batch changed the set
    is refused at that op. The batch is half run, so it must not be re-sent as a whole: the error is no
    longer `acknowledgeable` and says how many ops had already run."""
    if isinstance(exc, BatutaError) and exc.details and exc.details.get("acknowledgeable") is True:
        del exc.details["acknowledgeable"]
        exc.details["ops_run"] = ops_run


def run_batch(ctx, args):
    registry = ctx.registry
    commands = [registry.get(op["cmd"]) for op in args["ops"]]

    results = []
    mutated_any = False
    stopped = False
    for command, op in zip(commands, args["ops"]):
        before = ctx.mutations
        try:
            result = ctx.run_op(command, op["args"])
            results.append({"ok": True, "result": result})
            if command.is_mutating(op["args"], registry):
                ctx.note_mutation()
                mutated_any = True
        except Exception as exc:  # a failing op is reported inside the batch result
            _stop_asking_mid_batch(exc, len(results))
            touched = ctx.mutations > before
            error = from_exception(exc, partial=touched,
                                   edition_unknown=ctx.state.edition == "unknown")
            results.append({"ok": False, "error": error.to_wire()})
            mutated_any = mutated_any or touched
            if args["stop_on_error"]:
                stopped = True
                break
    # partial: the batch stopped at a failing op after something was already changed.
    return {"results": results, "executed": len(results), "partial": mutated_any and stopped}
