# Contributing

欢迎 PR / Issue。

## 最有价值的贡献

1. **场景 2/3/4 的实机验证**：A=Windows、B=macOS、A=Windows+B=macOS。附上安装输出、/health、9222 探测结果。
2. **WorkBuddy 版本适配**：升级后若 automations 表结构或页面 DOM 变化，修正 b/auto-run.mjs、b/cdp-send5.mjs。
3. **附件预览**：让 A 的附件在 B 的会话里显示成卡片（目前是路径传递）。
4. **多 B 路由**：给 budy 加 --target 别名，按名字路由到不同机器。

## 开发

    node test/e2e.mjs      # 不需要真机，16 项断言

CI 会在 Node 20/22 上跑上面的测试。

## 规范

- 不要提交 token、IP、个人路径；示例用 192.168.1.10 和 <token>
- 保持零第三方依赖（只用 Node 标准库）
- 改动 B 端脚本时同步 b/ 下的仓库副本
