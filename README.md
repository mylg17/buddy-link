# BuddyLink

[![ci](https://github.com/mylg17/buddy-link/actions/workflows/ci.yml/badge.svg)](https://github.com/mylg17/buddy-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-20%20%7C%2022-green.svg)]()

[English](README.en.md) | 简体中文

用 A 电脑上的 WorkBuddy 指挥 B 电脑上的 WorkBuddy：任务在 B 本机执行，B 的界面里能看到会话与过程，结果和产物回传 A。

**一台 A 可以指挥 N 台 B —— 你可以制造 N 个听话的同事。**

> Drive WorkBuddy on machine B from machine A — real GUI sessions executed on B, results and artifacts back on A.

## 特性

- 真·同会话续聊：同一 A 会话 → 同一 B 会话（CDP 驱动渲染层，不模拟鼠标）
- 锁屏可用：不依赖窗口焦点
- 附件与产物双向：A 传给 B，B 的产物回传到 A 工作区
- 零公网依赖：局域网 / Tailscale 直连
- 四种组合：A、B 各自支持 macOS / Windows
- 多 B：为每台 B 准备一份 env.json，用 BUDDY_ENV 切换，即可同时指挥 N 个执行体（示例见「使用」）

## 架构

    A（入口）                                  B（执行）
    ┌────────────────────────┐   HTTP 8765    ┌──────────────────────────────┐
    │ WorkBuddy 会话          │   Bearer       │ bridge.mjs                   │
    │  └ CODEBUDDY.md 规则    │ ─────────────► │  ├ /cdp ── CDP 9222 ──┐      │
    │ ~/.local/bin/buddy      │                │  │                    │      │
    │  ├ 画布识别（会话 id）   │                │  └ /auto ─ sqlite 任务 │      │
    │  ├ /upload 附件         │ ◄───────────── │            │           ▼      │
    │  ├ /cdp 或 /auto        │   结果与产物    │            │     WorkBuddy    │
    │  └ /result、/changes    │                │            └───► 桌面端       │
    └────────────────────────┘                └──────────────────────────────┘

两条执行路径：

| 路径 | 行为 | 依赖 |
|---|---|---|
| CDP（主） | 在 B 的同一个会话里追加消息 | WorkBuddy 带 --remote-debugging-port=9222 启动 |
| 一次性任务（兜底） | 写 B 的 automations 表，调度器新建会话 | 只需 WorkBuddy 在运行 |

## 前置要求

- 两台机器都安装并登录 WorkBuddy 桌面端
- B 安装 Node 18+（建议 22，用到 node:sqlite）
- 网络互通（局域网或 Tailscale），开放 8765
- B 的 WorkBuddy 用 CDP 参数启动（安装脚本会处理）

## 安装：四种组合

### 场景 1：A = macOS，B = Windows（已验证）

B（管理员 PowerShell）：

    cd buddy-link\b
    .\install-b.ps1 -Workdir "C:\buddy-link\work" -Port 8765

脚本会生成 token、写配置、开防火墙、注册两个登录自启任务（桥接 + 带调试端口的 WorkBuddy）。

A（终端）：

    bash tools/install-a-macos.sh
    # 编辑 ~/.buddy-link/env.json，填入 B 的 IP 与 token

### 场景 2：A = Windows，B = Windows

B：同场景 1。

A（PowerShell）：

    cd buddy-link\tools
    .\install-a-windows.ps1 -BuddyUrl "http://192.168.1.10:8765" -Token "<token>"

新开终端后：

    buddy.cmd auto "回复 OK"

### 场景 3：A = macOS，B = macOS

B（终端）：

    cd buddy-link/b
    bash install-b-macos.sh 8765

会生成配置与两个 LaunchAgent（桥接、带 CDP 的 WorkBuddy 启动）。先确认 CDP：

    curl http://127.0.0.1:9222/json/version

A：

    bash tools/install-a-macos.sh

### 场景 4：A = Windows，B = macOS

B：同场景 3。A：同场景 2。

## 配置（B 端）

B 的行为由 b/buddy-link.config.json 决定：

| 键 | 说明 |
|---|---|
| platform | win32 / darwin |
| homeDir | B 的用户目录 |
| workdir | 工作目录（产物从这里回传） |
| autoDb | workbuddy.db 路径 |
| projectsDir | 会话记录目录 |
| nodeBin | node 可执行文件 |
| token | 访问令牌（40 位随机） |
| port | 桥接端口，默认 8765 |
| permissionMode | bypassPermissions（无人值守） |

示例见 b/buddy-link.config.example.json 与 b/buddy-link.config.macos.example.json。

## 使用

在 A 的 WorkBuddy 会话里直接说任务，或在终端：

    buddy auto "用 PowerShell 列出 C:\buddy-link\work 的文件"
    buddy auto "看这个表格" --file ~/Downloads/report.xlsx

指挥多台 B（每台一份 env.json）：

    BUDDY_ENV=~/.buddy-link/b1.json buddy auto "..."
    BUDDY_ENV=~/.buddy-link/b2.json buddy auto "..."

- 同一 A 会话的连续指令 → 同一个 B 会话
- 新建 A 会话 → B 新建会话
- 产物自动回传到 ~/BuddyLink/artifacts/<会话>/

## 安全

见 SECURITY.md。核心三条：强 token、只在内网、CDP 端口不对外。

## 已知限制

1. CDP 需要 WorkBuddy 用 --remote-debugging-port=9222 启动；从开始菜单直接打开则退回一次性任务（新会话）
2. A 到 B 的附件目前以路径传递，B 会话里不显示附件卡片
3. 单轮等待上限 5 分钟，超时提示未取到新结果
4. 一次性任务路径依赖 WorkBuddy 内部表结构，升级可能失效
5. 场景 2/3/4（A=Windows、B=macOS）已提供脚本但未经实机验证，欢迎 PR 反馈

## 自测

    node test/e2e.mjs        # 本机假 CLI，16 项断言
    node test/mcp-live.mjs   # 真机冒烟（需配置 BUDDY_URL/TOKEN）

## 目录

    buddy-link/
    ├── a/        A 端规则与 MCP 工具（可选）
    ├── b/        B 端桥接、辅助脚本、安装脚本
    ├── tools/    A 端启动器与安装脚本
    └── test/     本机自测

## License

MIT