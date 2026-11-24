# BuddyLink

[简体中文](README.md) | English

**Control WorkBuddy on machine B from WorkBuddy on machine A.**
Tasks run on B, the session is visible in B's GUI, and results plus artifacts come back to A.

**One A can command N Bs - create as many obedient colleagues as you have machines.**

## Features

- True session continuity: one A conversation maps to one B conversation (driven through CDP, not synthetic mouse clicks)
- Works while B is locked: no window focus required
- Attachments both ways: A to B, and B's artifacts back into A's workspace
- No public exposure needed: LAN or Tailscale only
- Four combinations: A and B may each run macOS or Windows
- Multiple Bs: keep one env.json per machine and switch with BUDDY_ENV

## Architecture

    A (entry)                                  B (executor)
    +------------------------+   HTTP 8765    +------------------------------+
    | WorkBuddy session      |   Bearer       | bridge.mjs                   |
    |  - CODEBUDDY.md rules  | -------------> |  - /cdp --- CDP 9222 --+     |
    | ~/.local/bin/buddy     |                |  - /auto -- sqlite job |     |
    |  - canvas detection    | <------------- |            |           v     |
    |  - /upload attachments |  results and   |            |     WorkBuddy    |
    |  - /cdp or /auto       |  artifacts     |            +---> desktop     |
    |  - /result, /changes   |                |                              |
    +------------------------+                +------------------------------+

Two execution paths:

| Path | Behavior | Requirement |
|---|---|---|
| CDP (primary) | Appends a message to the same B session | WorkBuddy started with --remote-debugging-port=9222 |
| One-shot task (fallback) | Writes B's automations table; the scheduler creates a new session | WorkBuddy running |

## Requirements

- WorkBuddy desktop installed and signed in on both machines
- Node 18+ on B (22 recommended, uses node:sqlite)
- Network reachability (LAN or Tailscale), port 8765 open
- WorkBuddy on B started with the CDP flag (installers handle it)

## Install: four scenarios

### Scenario 1: A = macOS, B = Windows (verified)

B (Administrator PowerShell):

    cd buddy-link\b
    .\install-b.ps1 -Workdir "C:\buddy-link\work" -Port 8765

The script generates a token, writes the config, opens the firewall and registers two logon tasks (bridge and WorkBuddy with the debug port).

A (terminal):

    bash tools/install-a-macos.sh
    # then edit ~/.buddy-link/env.json with B's IP and token

### Scenario 2: A = Windows, B = Windows

B: same as scenario 1.

A (PowerShell):

    cd buddy-link\tools
    .\install-a-windows.ps1 -BuddyUrl "http://192.168.1.10:8765" -Token "<token>"

Open a new terminal:

    buddy.cmd auto "reply OK"

### Scenario 3: A = macOS, B = macOS

B (terminal):

    cd buddy-link/b
    bash install-b-macos.sh 8765

This creates the config and two LaunchAgents (bridge, WorkBuddy with CDP). Verify CDP first:

    curl http://127.0.0.1:9222/json/version

A:

    bash tools/install-a-macos.sh

### Scenario 4: A = Windows, B = macOS

B: same as scenario 3. A: same as scenario 2.

## Configuration (B side)

B is configured by b/buddy-link.config.json:

| Key | Meaning |
|---|---|
| platform | win32 / darwin |
| homeDir | B's home directory |
| workdir | working directory (artifacts are collected here) |
| autoDb | path to workbuddy.db |
| projectsDir | session transcripts directory |
| nodeBin | node executable |
| token | access token (40 random chars) |
| port | bridge port, default 8765 |
| permissionMode | bypassPermissions for unattended runs |

See b/buddy-link.config.example.json and b/buddy-link.config.macos.example.json.

## Usage

Talk to A's WorkBuddy session, or use the terminal:

    buddy auto "use PowerShell to list C:\buddy-link\work"
    buddy auto "check this spreadsheet" --file ~/Downloads/report.xlsx

Command several B machines (one env.json each):

    BUDDY_ENV=~/.buddy-link/b1.json buddy auto "..."
    BUDDY_ENV=~/.buddy-link/b2.json buddy auto "..."

- Consecutive instructions in one A session reuse the same B session
- A new A session creates a new B session
- Artifacts are copied back to ~/BuddyLink/artifacts/<canvas>/

## Security

See SECURITY.md. In short: strong token, internal network only, never expose the CDP port.

## Known limitations

1. CDP requires WorkBuddy to be launched with --remote-debugging-port=9222; launching from the Start menu falls back to one-shot tasks (new session per turn)
2. Attachments from A are passed as file paths; B's chat does not show attachment cards
3. Single-run wait limit is 5 minutes; longer tasks report no new result
4. The one-shot path depends on WorkBuddy's internal table schema and may break on upgrades
5. Scenarios 2/3/4 (A=Windows, B=macOS) ship with scripts but have not been verified on real hardware; PRs welcome

## Tests

    node test/e2e.mjs        # local fake CLI, 16 assertions
    node test/mcp-live.mjs   # live smoke test (set BUDDY_URL/TOKEN)

## Layout

    buddy-link/
    +-- a/        A-side rules and optional MCP tools
    +-- b/        B-side bridge, helpers and installers
    +-- tools/    A-side launchers and installers
    +-- test/     local tests

## License

MIT