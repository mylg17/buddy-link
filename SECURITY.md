# Security

BuddyLink 会在 B 机器上执行 A 下发的指令，请把 B 当成一台可被远程操作的机器。

## 必须做

1. 强 token：40 位随机串，写入 B 的 buddy-link.config.json；A 侧放在 ~/.buddy-link/env.json（权限 600）
2. 不要暴露公网：只在内网或 Tailscale/ZeroTier 使用
3. 防火墙只放行 A 的 IP 访问 B 的 8765 端口

## 风险点

| 组件 | 风险 | 建议 |
|---|---|---|
| 桥接 8765 | 拿到 token 即可在 B 上执行命令 | 强 token + 内网隔离 |
| CDP 9222 | 本机程序可控制 WorkBuddy | 只监听 127.0.0.1，不映射公网 |
| bypassPermissions | B 上的命令不经确认 | 专用工作目录 + allowReadRoots |
| automations 表写入 | 依赖内部表结构，升级可能失效 | 保留 CDP 兜底 |

## 不建议

- 在存放敏感数据的机器上长期以 bypassPermissions 运行
- 把 token 提交到仓库（.gitignore 已排除 buddy-link.config.json）
