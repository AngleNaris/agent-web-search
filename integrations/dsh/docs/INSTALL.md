# dsh-agent-web-search 安装教程

`dsh-agent-web-search` 是本项目的 DeepSeek Harness（DSH）原生插件。
它注册一个原生 `ctx.web` 搜索 provider（`agent-web-search`），把 DSH 自带
`web_search` 的实现换成 confl 本项目的搜索能力；模型侧看到的仍然是原生
`web_search`，不会多出 `mcp__...__web_search`。

内置搜索请求由插件派生一个本地 `agent-web-search-mcp` 子进程（stdio）完成，
所以除了装 DSH 插件，还要在 DSH 宿主的 Python 环境里装 Python 包。

## 前置条件

- DSH（桌面版或 CLI 版均可；已在 `0.2.0-rc.2` 上实测通过）。
- Python `>= 3.10`，且 `python -m pip` 可用。
- 不需要任何 API Key 也能跑：默认启用的 Exa / Parallel / DuckDuckGo 都有
  免 key 路径；其余上游在「设置 → agent-web-search」里配好凭据再打开。

## 一键安装 prompt

把下面整段粘贴给 DSH 里任意能执行命令的 agent，它会照着做完并汇报结果：

```text
请把 agent-web-search 的 DSH 原生插件装到当前 profile 并验证可用：

1. 用桌面版/CLI 自带的 dsh 命令安装指定分支的原生 bundle：
   dsh plugin --profile <profile> add github:AngleNaris/agent-web-search#feat/dsh-native-plugin
   注意：这是 DSH 原生 bundle 安装，不是添加 MCP Server；
   模型侧工具名必须保持原生 web_search，不能出现 mcp__...__web_search。

2. 在 DSH 宿主能找到的 Python 环境里安装搜索运行时：
   python -m pip install agent-web-search-mcp
   装完确认 agent-web-search-mcp --help 能运行，
   且该命令所在目录在 DSH 进程的 PATH 里；
   如果不在 PATH 里，用 AGENT_WEB_SEARCH_MCP_COMMAND 指向可执行文件绝对路径。

3. 确认模型侧 web_search 入口可用（tool-web 开启），
   且 web.searchProvider 指向 agent-web-search，
   内置 web-search-deepseek 处于关闭状态。

4. 用 web_search 做一次真实搜索（例如查 DuckDuckGo 官网），
   只需要返回是否成功、命中了哪个上游、结果条数；
   不要把整页搜索内容贴出来。

5. 最后汇报：实际加载的插件名、版本、分支提交、当前 profile，
   以及 Python 包版本和所在 Python 环境。
```

把 `<profile>` 换成你的 profile 名（桌面版一般是 `desktop`）。

## 手动步骤

```bash
# 1. 安装 DSH 原生 bundle（指定分支）
dsh plugin --profile desktop add github:AngleNaris/agent-web-search#feat/dsh-native-plugin

# 2. 安装 Python 搜索运行时（和 DSH 宿主同一个 Python 环境）
python -m pip install agent-web-search-mcp

# 3. 确认命令可用
agent-web-search-mcp --help
```

然后在 DSH「设置 → 插件」里确认 `dsh-agent-web-search` 已启用，
在「设置 → agent-web-search」里可以看到上游列表、搜索策略和调用记录。
如果模型侧没有 `web_search` 工具，把 `tool-web`（`include:tool-web`）打开；
插件的 Cordis patch 只覆盖 `web.searchProvider`，不负责开关模型工具入口。

## 验证清单

- [ ] 插件列表里有 `dsh-agent-web-search`，状态为启用。
- [ ] `web.searchProvider` 的值是 `agent-web-search`。
- [ ] 内置 `web-search-deepseek` 已关闭（避免页面上挂着一个永远不被选中的 provider）。
- [ ] `agent-web-search-mcp --help` 在 DSH 宿主环境里能运行。
- [ ] 用 `web_search` 搜一次能返回带 `【来源：…】` 归因的结果。

## 排错

- **搜
...[truncated 1583 chars]