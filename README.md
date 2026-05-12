# adb-mcp-server

> ADB over MCP. Drive an Android device over the network from any MCP-compatible agent.

[![npm](https://img.shields.io/npm/v/@sfaizi24/adb-mcp-server)](https://www.npmjs.com/package/@sfaizi24/adb-mcp-server)
[![license](https://img.shields.io/npm/l/@sfaizi24/adb-mcp-server)](LICENSE)
[![node](https://img.shields.io/node/v/@sfaizi24/adb-mcp-server)](#requirements)

## What problem this solves

You have an Android device — phone, tablet, e-reader — that you want an LLM agent to operate. The other ADB MCP servers on GitHub assume the device is plugged into the same machine the agent runs on. That doesn't work if the agent lives on a server (a droplet, a CI runner, a home-lab box) and the device is somewhere else on the network.

This server is built for that network-first case. The device is reachable at `<host>:5555` over Wi-Fi, Tailscale, a VPN — anything routable. The design follows from that:

- **No tool-call races.** All ADB calls go through a single queue, so parallel agent calls don't trample each other.
- **No screencap loops.** Captures are rate-limited to one per 10 seconds.
- **Classified errors.** The agent can tell "device offline" from "ADB unauthorized" from "host unreachable", and recover differently.
- **Path allowlists on push/install.** `adb_push` and `adb_install` reject sources outside configured prefixes, with traversal-resistant checks.

## How to use it

### Claude Desktop / Claude Code

```jsonc
// e.g. ~/.config/claude/mcp.json
{
  "mcpServers": {
    "adb": {
      "command": "npx",
      "args": ["-y", "@sfaizi24/adb-mcp-server"],
      "env": { "ADB_HOST": "192.168.1.42" }
    }
  }
}
```

### OpenClaw

```yaml
# plugins.entries.acpx.config.mcpServers
adb:
  command: npx
  args: ["-y", "@sfaizi24/adb-mcp-server"]
  env:
    ADB_HOST: "100.64.0.5"
```

### Manual / dev

```bash
git clone https://github.com/sfaizi24/adb-mcp-server.git
cd adb-mcp-server
npm install
ADB_HOST=192.168.1.42 node index.js
```

## Tools

- `adb_status` — Connection check + device info (model, Android version, SDK level).
- `adb_shell` — Run a shell command. Output truncated at 100KB.
- `adb_screencap` — Capture the screen as PNG, saved to a temp file on the host. Rate-limited to 1 per 10s.
- `adb_ui_dump` — Structured JSON dump of the UI hierarchy, with computed centerpoints for taps. Filters: `clickable_only`, `with_text_only`, `include_raw_xml`.
- `adb_install` — Install an APK. Reinstalls allowed; downgrades blocked. Source path allowlisted.
- `adb_push` — Push a file from host to device. Source path allowlisted.
- `adb_pull` — Pull a file from device to host. Default destination is `/tmp/`.
- `adb_input` — Simulate input: `tap` (x, y), `swipe` (x1, y1, x2, y2, duration_ms?), `keyevent` (code), `text` (value).

## Requirements

- Node 18+
- `adb` on PATH, or set `ADB_BIN` to its absolute path
  - macOS: `brew install android-platform-tools`
  - Linux: `apt install android-tools-adb`, or download the SDK platform-tools archive
  - Windows: download platform-tools, add the directory to PATH
- A target Android device with ADB over TCP enabled (see below)

## Enabling ADB over TCP on the device

One-time setup:

1. Connect the device to a host via USB.
2. On the device: enable Developer Options, then USB debugging.
3. Approve the host's ADB key when prompted.
4. On the host: `adb tcpip 5555`.
5. Unplug. The device now accepts ADB at `<device-ip>:5555`.

Find the device's IP under `Settings → About → Status`, or in the Wi-Fi details. On Tailscale, use the Tailscale IP.

ADB over TCP usually does not survive reboot. Re-plug and run `adb tcpip 5555` again to re-enable.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ADB_HOST` | yes | — | Device hostname or IP. `192.168.1.42`, `100.64.0.5` (Tailscale), `phone.local` (mDNS), etc. |
| `ADB_PORT` | no | `5555` | ADB TCP port on the device. |
| `ADB_BIN` | no | `adb` | Path to the `adb` binary if not on PATH. |
| `MCP_ALLOWED_PUSH_DIRS` | no | `/tmp/` | Comma-separated absolute prefixes that `adb_push` may read from. |
| `MCP_ALLOWED_INSTALL_DIRS` | no | `/tmp/` | Comma-separated absolute prefixes that `adb_install` may read APKs from. |

## Security

- This server gives any connected agent **shell access and APK install ability** on the target device. Only run it on hosts where you trust the agents that can call its tools.
- Network ADB has **no authentication**. Anyone with network reach to `<device>:5555` can connect. Restrict via firewall, Tailscale ACL, or VPN. **Do not expose port 5555 to the open internet.**
- `adb_push` and `adb_install` allowlist source paths (default `/tmp/`). The check resolves paths first (`path.resolve`), so `../` traversal does not bypass it. Symlink leaves are rejected; symlinked ancestor directories are not separately blocked — keep allowlist directories out of writable-by-untrusted-user space.

## License

MIT. See [LICENSE](LICENSE). Contributions accepted under the same terms — please run `npm test` before opening a PR.

## Acknowledgements

Built on [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
