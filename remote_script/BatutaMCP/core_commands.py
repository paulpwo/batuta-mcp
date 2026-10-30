"""Core commands that need no Live Object Model access: `catalog` and the `batch` framework."""

from . import batch as batch_module
from . import validator as v
from .limits import BATCH_TIMEOUT_MS
from .registry import Command


def install(registry, script_version):
    """Register the core commands on `registry` (called from command_set.build_registry)."""

    def catalog(ctx, args):
        return {"commands": ctx.registry.catalog_entries(), "script_version": script_version}

    registry.register(Command("catalog", v.obj({}), catalog))
    registry.register(Command(
        "batch", batch_module.BATCH_SCHEMA, batch_module.run_batch,
        mutating=batch_module.batch_is_mutating,
        destructive="conditional", conditions=("ops",),
        default_timeout_ms=BATCH_TIMEOUT_MS,
        prepare=batch_module.prepare_batch, precheck=batch_module.precheck_batch))
