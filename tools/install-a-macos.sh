#!/usr/bin/env bash
# BuddyLink - A 端安装（macOS）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "请先安装 Node 18+（建议 22）"; exit 1; fi
mkdir -p "$HOME/.local/bin" "$HOME/.buddy-link" "$HOME/BuddyLink/artifacts"
cp "$DIR/buddy" "$HOME/.local/bin/buddy"
chmod +x "$HOME/.local/bin/buddy"
if [ ! -f "$HOME/.buddy-link/env.json" ]; then
  printf '{"url":"http://<B的IP>:8765","token":"<token>"}' > "$HOME/.buddy-link/env.json"
  chmod 600 "$HOME/.buddy-link/env.json"
  echo "已生成 $HOME/.buddy-link/env.json，请填入 B 的地址和 token"
fi
echo "安装完成：$HOME/.local/bin/buddy"
echo "请确保 $HOME/.local/bin 在 PATH 中"
