"""The one place where command groups are installed (T3 and T4 append their installers here)."""

from . import (arrangement_commands, browser_commands, clip_commands, core_commands, device_commands,
               envelope_commands, mixer_commands, rack_commands, scene_commands, session_commands,
               track_commands, view_commands)
from .limits import SCRIPT_VERSION
from .registry import CommandRegistry


def _install_core(registry):
    core_commands.install(registry, SCRIPT_VERSION)


# Each installer receives the registry and registers its Command records. Add new groups here.
INSTALLERS = (
    _install_core,
    session_commands.install,   # T3: session, transport, undo/redo
    track_commands.install,     # T3: tracks and meters
    mixer_commands.install,     # T3: mixer and routing
    scene_commands.install,     # T3: scenes and cue points
    clip_commands.install,      # T4a: clips, slots and notes
    envelope_commands.install,  # T4a: session clip envelopes
    arrangement_commands.install,  # T4a: arrangement clips
    device_commands.install,    # T4b: devices and parameters
    rack_commands.install,      # T4b: racks, chains and drum pads
    browser_commands.install,   # T4b: browser tree, search and load
    view_commands.install,      # T5c-1: application view switch
)


def build_registry():
    registry = CommandRegistry()
    for installer in INSTALLERS:
        installer(registry)
    registry.freeze()
    return registry
