#!/usr/bin/env bash
# BuddyLink - B 端安装（macOS）
# 用法： ./install-b-macos.sh [端口] [token]
set -e
PORT="${1:-8765}"
TOKEN="${2:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/buddy-link"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "请先安装 Node 18+（建议 22）"; exit 1; fi
if [ -z "$TOKEN" ]; then TOKEN="$(openssl rand -hex 20)"; fi

mkdir -p "$ROOT/b" "$ROOT/work" "$ROOT/inbox" "$ROOT/logs" "$ROOT/state"
cp "$DIR"/*.mjs "$ROOT/b/" 2>/dev/null || true
cp "$DIR"/package.json "$ROOT/b/" 2>/dev/null || true
cp "$DIR/hooks"/*.plist "$ROOT/b/" 2>/dev/null || true

cat > "$ROOT/b/buddy-link.config.json" <<EOF
{
  "token": "$TOKEN",
  "host": "0.0.0.0",
  "port": $PORT,
  "workdir": "$ROOT/work",
  "platform": "darwin",
  "homeDir": "$HOME",
  "nodeBin": "$NODE_BIN",
  "autoDb": "$HOME/.workbuddy/workbuddy.db",
  "projectsDir": "$HOME/.workbuddy/projects",
  "permissionMode": "bypassPermissions",
  "promptVia": "arg",
  "maxRunMs": 2700000,
  "allowReadRoots": ["$ROOT/work", "$ROOT"]
}
EOF
chmod 600 "$ROOT/b/buddy-link.config.json"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/com.buddylink.bridge.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.buddylink.bridge</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$ROOT/b/bridge.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/bridge.err.log</string>
</dict></plist>
EOF

cat > "$HOME/Library/LaunchAgents/com.buddylink.workbuddy-cdp.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.buddylink.workbuddy-cdp</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/open</string>
    <string>-a</string><string>WorkBuddy</string>
    <string>--args</string><string>--remote-debugging-port=9222</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF

launchctl unload "$HOME/Library/LaunchAgents/com.buddylink.bridge.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.buddylink.bridge.plist"
launchctl unload "$HOME/Library/LaunchAgents/com.buddylink.workbuddy-cdp.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.buddylink.workbuddy-cdp.plist"

echo "token: $TOKEN"
echo "验证: curl http://127.0.0.1:$PORT/health"
echo "CDP: curl http://127.0.0.1:9222/json/version"
