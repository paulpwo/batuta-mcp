"""Closed command allowlist (docs/01-protocol.md section 5.2).

Commands are registered once, at load time, as `Command` records that bind a name to a fixed
handler function and a declarative argument schema. Lookup is a plain dict `get`: client strings
are never used to reach attributes, modules or functions.
"""

import re
from dataclasses import dataclass
from typing import Any, Callable, Optional, Tuple, Union

from . import limits
from .errors import BatutaError

_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class RegistryError(Exception):
    """Programming error while building the registry (duplicate or late registration)."""


@dataclass(frozen=True)
class Command:
    """One allowlisted command.

    handler(ctx, args) runs on Live's main thread. `mutating` may be a bool or a callable
    (args, registry) -> bool for commands such as `batch`. `prepare(args, registry)` runs on the
    socket thread right after schema validation and may do deeper static checks.
    `edition_delta(args)` returns {"tracks"|"scenes"|"returns": +/-n} so batch can project counts.
    """

    name: str
    schema: dict
    handler: Callable[[Any, dict], dict]
    mutating: Union[bool, Callable[[dict, Any], bool]] = False
    destructive: str = "never"  # never | conditional | always
    conditions: Tuple[str, ...] = ()
    undo_wrapped: bool = True
    default_timeout_ms: int = limits.DEFAULT_TIMEOUT_MS
    prepare: Optional[Callable[[dict, Any], dict]] = None
    edition_delta: Optional[Callable[[dict], Optional[dict]]] = None
    precheck: Optional[Callable[[Any, dict], None]] = None  # (ctx, args), runs BEFORE the undo step
    resumable: bool = False  # handler is a generator the pump resumes each tick (read-only commands)

    def is_mutating(self, args, registry):
        if callable(self.mutating):
            return bool(self.mutating(args, registry))
        return bool(self.mutating)


class CommandRegistry:
    def __init__(self):
        self._commands = {}
        self._frozen = False

    def register(self, command):
        if self._frozen:
            raise RegistryError("registry is frozen")
        if not _NAME_PATTERN.match(command.name):
            raise RegistryError("bad command name %r" % (command.name,))
        if command.name in self._commands:
            raise RegistryError("duplicate command %r" % (command.name,))
        if command.destructive not in ("never", "conditional", "always"):
            raise RegistryError("bad destructive classification for %r" % (command.name,))
        if command.resumable and (command.mutating or command.destructive != "never"):
            raise RegistryError("resumable command %r must be read-only" % (command.name,))
        self._commands[command.name] = command

    def freeze(self):
        self._frozen = True

    def get(self, name):
        """Allowlist lookup; unknown or non-string names give None."""
        if type(name) is not str:
            return None
        return self._commands.get(name)

    def names(self):
        return sorted(self._commands)

    def prepare_call(self, name, args):
        """Resolve `name`, validate `args`; return (command, normalized_args) or raise BatutaError."""
        command = self.get(name)
        if command is None:
            shown = name if type(name) is str else None
            raise BatutaError("unknown_command", "unknown command", {"cmd": shown})
        from .validator import validate  # local import keeps the module graph acyclic
        normalized = validate(command.schema, args)
        if command.prepare is not None:
            normalized = command.prepare(normalized, self)
        return command, normalized

    def catalog_entries(self):
        entries = []
        for name in self.names():
            command = self._commands[name]
            entries.append({
                "name": name,
                "mutating": callable(command.mutating) or bool(command.mutating),
                "destructive": command.destructive,
                "conditions": list(command.conditions),
            })
        return entries
