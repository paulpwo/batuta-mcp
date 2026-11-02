# batuta-transport

A Claude Code plugin that shows an Ableton Live transport bar above the prompt: to start, back a bar, play/stop, forward a bar, plus a status line and a hide button.

## Requirements

- The `batuta` MCP server registered in Claude Code (see [docs/02-install.md](../../../docs/02-install.md)).
- Ableton Live running with the BatutaMCP control surface selected.
- Claude Code's fullscreen renderer (`/tui fullscreen`, saved as `"tui": "fullscreen"` in `~/.claude/settings.json`; `install.sh` sets it). On the default renderer the bar shows and follows Live, but its buttons get no clicks or focus.
- One Live client at a time: the bar uses the same single Live connection as the MCP server, so close other BatutaMCP clients first.

The bar shows only while Live answers and hides when Live closes.

## Install

```sh
claude plugin marketplace add '/absolute/path/to/BatutaMCP/clients/claude-code'
claude plugin install batuta-transport@batuta --scope user
```

The BatutaMCP installer prints these two commands with your path filled in. It never runs them.

## Use

- `/transport` toggles the bar.
- After updating the plugin, run `/reload-plugins`. The installed plugin is a copy: after changing the files here, run `claude plugin marketplace update batuta` and `claude plugin update batuta-transport@batuta` first.

## Test

```sh
claude plugin test clients/claude-code/batuta-transport
```
