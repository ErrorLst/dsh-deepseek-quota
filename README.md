# @dsh-external/dsh-deepseek-quota

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
插件：在聊天输入框上方的统计行（`1 轮 · 14 步 | LLM … | 缓存命中 …`）
正下方，显示一条 DeepSeek 额度行：

```
余额：¥274.70 | 当前会话：¥0.0115 | 本轮对话：¥0.0038 | 子代理：¥0.0011
```

## 功能特性

### 会话额度行

- 注册在 `conversation.composer.dock` 插槽（order 1，紧跟在内置统计行下方），
  显示四段金额：
  - **余额**：DeepSeek 账户总剩余额度（5 分钟轮询）。每次刷新后在括号内显示
    与上次刷新的**变化量**（`余额：¥274.70（-0.05）`），余额减少显示红色
    `-`，增加显示绿色 `+`；悬停打开**多标签明细面板**：`每 5 分钟`（逐次
    刷新变化量）、`每 1 小时`（每小时末余额的差值）、`每 1 天`（每天末余额
    的差值），每个视图固定 10 行无滚动条，并显示赠金/充值信息。余额快照与
    三类历史**持久化在浏览器 localStorage**，刷新页面后即时恢复；
  - **当前会话**：整个会话日志累计消耗（跨轮次、跨工具步骤）；
  - **本轮对话**：最新一轮（含该轮全部步骤）的消耗，流式输出期间实时增长；
    新的一轮开启但尚无请求时显示 `—`，不回放上一轮的最终额度；
  - **子代理**：本会话全部**持久化后代子代理**（含已完成、已冷存的）的累计消耗。
- **数据来自持久日志而非 API**：宿主端重放会话事件，折叠提供方上报的用量桶
  （未缓存输入 / 缓存读取 / 缓存写入 / 输出，与 token-meter 投影同一套语义），
  并按 DeepSeek 官方峰谷分时价目表计价。会话刷新、重启、翻页、压缩后数字不变
  ——用量随会话持久化，金额只是对持久数据的即时视图。
- **子代理不会重复计费**：子代理日志开头的父会话继承前缀（seed）被跳过，
  其用量只统计从 `seedLength` 起的自有事件；非 DeepSeek 模型的子代理不计价。
- **官方峰谷分时定价**（2026-08-17 起生效，北京时间，元/百万 tokens）：

  | 模型 | 时段 | 输入（缓存命中） | 输入（缓存未命中） | 输出 |
  | --- | --- | --- | --- | --- |
  | `deepseek-chat`（V4-Flash） | 高峰 09:00–12:00 / 14:00–18:00 | 0.10 | 3.00 | 9.00 |
  | `deepseek-chat`（V4-Flash） | 空闲（其余时间） | 0.05 | 1.50 | 4.50 |
  | `deepseek-reasoner`（V4-Pro） | 高峰 09:00–12:00 / 14:00–18:00 | 0.30 | 9.00 | 27.00 |
  | `deepseek-reasoner`（V4-Pro） | 空闲（其余时间） | 0.15 | 4.50 | 13.50 |

  每个请求按**请求发生时刻**（事件时间戳，换算北京时间）选择高峰/空闲单价；
  模型按 id 归入对应档位（`*chat*`/`*flash*` → V4-Flash，`*reasoner*`/`*pro*`
  → V4-Pro，未知模型回退到 `deepseek-chat` 档）。价格可通过行配置覆盖。
- **三段分别可悬停查看明细**（悬浮面板，随主题样式渲染）：
  - 悬停**当前会话**：按模型（Flash / Pro 等档位）细分的**额度消耗**——
    输入（未命中）、缓存输入、输出三个计费桶各自的折算金额与合计；
  - 悬停**本轮对话**：本轮每一个请求（步骤）的时间、高峰/空闲、模型，
    以及输入（未命中）、缓存输入、输出三个计费桶各自的折算金额与合计
    （最多同时显示 5 行，超过内部滚动；超过 200 条请求截断显示）；
  - 悬停**子代理**：每个子代理的模型、三个计费桶的折算金额与合计；非
    DeepSeek 模型的子代理显示 `-` 占位，不计入总额。
- 零运行时依赖；额度计算不调用 DeepSeek API（仅余额段需要 API Key）。

## 环境要求

- DeepSeek Harness **web profile**（`dsh web`）——该 bundle 只在 web profile 挂载。
- 余额段需要配置 DeepSeek API Key（额度计算不需要）：
  - Web 界面「设置 > 模型」页，或
  - `~/.dsh/.credentials.yaml`（`DEEPSEEK_API_KEY`），或
  - `DEEPSEEK_API_KEY` 环境变量。

## 安装

本插件是 **bundle 插件**：即 npm 包清单中声明了 `dsh.bundle`，其
`cordis.patch.yml` 层会被组合进 profile。

### 从 Git 仓库安装

```sh
dsh plugin --profile web add git+https://github.com/ErrorLst/dsh-deepseek-quota.git
```

然后确保 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 中列有
`"@dsh-external/dsh-deepseek-quota"`（Web 界面自带的插件管理器会自动登记 bundle 层；裸 CLI
只是转发 pnpm，需要手动加）。重启 `dsh web`。

### 本地目录安装（开发调试）

```sh
dsh plugin --profile web add link:C:/path/to/dsh-deepseek-quota
```

本地开发请用 `link:`（符号链接）而不是 `file:`：`file:` 会在安装时把插件
**拷贝**进 profile 的 `node_modules`，之后对插件目录的修改不会被 Web 服务读到
（表现为主机端新路由 404、界面没有新功能）；`link:` 让 `node_modules` 直接指向
插件目录，改动即时可见——宿主端改动重启 `dsh web` 生效，浏览器端改动刷新页面即可。

同样完成上述 bundle 层登记后重启。

### 从 npm 安装（发布后）

```sh
dsh plugin --profile web add @dsh-external/dsh-deepseek-quota
```

### 卸载

```sh
dsh plugin --profile web remove @dsh-external/dsh-deepseek-quota
```

并从 profile 的 `package.json` 的 `dsh.profile.bundles` 中移除该名称。

## 使用

打开 Web 界面：额度行位于聊天输入框上方统计行的正下方。悬停
「当前会话 / 本轮对话 / 子代理」查看明细面板；悬停「余额」查看赠金/充值明细。

也可以直接访问接口：

```sh
curl http://127.0.0.1:3080/api/deepseek-quota
curl http://127.0.0.1:3080/api/deepseek-quota?refresh=1
curl "http://127.0.0.1:3080/api/deepseek-quota/context?sessionId=<session-id>"
```

## HTTP API

### `GET /api/deepseek-quota`（由宿主编通过 `webServer` 提供）

```jsonc
// 成功
{
  "ok": true,
  "isAvailable": true,
  "balances": [
    { "currency": "CNY", "total": "123.45", "granted": "10.00", "toppedUp": "113.45" }
  ],
  "fetchedAt": 1735689600000
}

// 失败 — code 取值：
//   MISSING_KEY    未配置 API Key
//   AUTH           DeepSeek 拒绝该 Key（HTTP 401）
//   HTTP_<status>  上游其他 HTTP 错误
//   TRANSPORT      网络/超时错误
{ "ok": false, "code": "MISSING_KEY", "message": "DEEPSEEK_API_KEY 未配置：…" }
```

`GET /api/deepseek-quota?refresh=1` 绕过 TTL 缓存；非 GET 请求返回 `405`。

### `GET /api/deepseek-quota/context?sessionId=<id>`

```jsonc
{
  "ok": true,
  "currency": "CNY",
  "pricingVersion": "deepseek-v4-2026-08-17",
  "session": {
    "cost": 0.01145,
    "uncachedInputTokens": 2000,
    "cacheReadTokens": 2000,
    "cacheWriteTokens": 0,
    "outputTokens": 1000,
    "model": "deepseek-chat",
    "provider": "deepseek",
    "tier": "deepseek-chat",
    "steps": 2
  },
  "turn": { "turn": 1, "cost": 0.00375, "uncachedInputTokens": 1000, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 500, "steps": 1 },
  "subagents": {
    "cost": 0.001125,
    "count": 2,
    "children": [
      { "id": "…", "label": "…", "cost": 0.000375, "uncachedInputTokens": 100, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 50, "model": "deepseek-chat", "provider": "deepseek" }
    ]
  },
  "computedAt": 1755446400000
}

// 失败 — code 取值：
//   MISSING_SESSION    缺少 sessionId 查询参数
//   SESSION_NOT_FOUND  会话既不在线也不在持久化存储中
//   INTERNAL           计算过程异常（如子代理枚举超时/持久化读取失败）
{ "ok": false, "code": "MISSING_SESSION", "message": "缺少 sessionId 查询参数" }
```

说明：

- `session` / `turn` / `subagents.*` 的金额单位与 `currency` 一致（默认人民币元）。
- 金额按当前价目表即时折算；**token 桶才是持久化的真实数据**，价格调整只会影响
  展示金额，不会改变会话日志中的用量。
- 子代理枚举由 `ctx.subagents.listDescendants` 提供（持久化优先合并在线会话），
  子代理读取失败或超时不会影响主会话数字，仅以 `subagents.error` 标注。
- 结果按会话短缓存（`contextCacheTtlMs`，默认 5 秒），切换会话时额度行秒出；
  `GET /api/deepseek-quota/context?sessionId=<id>&refresh=1` 可绕过缓存取最新值。
- 浏览器端额度行在加载完成前先渲染等高的占位行（`…`），数据到达后原位替换，
  因此切换会话不会出现布局跳动；切回已看过的会话会先显示缓存值再刷新。

## 配置

| 配置项             | 设置方式                                   | 默认值                      |
| ------------------ | ------------------------------------------ | --------------------------- |
| API 地址           | `DEEPSEEK_BASE_URL` 环境变量，或行配置 `baseURL` | `https://api.deepseek.com` |
| 缓存 TTL           | 行配置 `ttlMs`                             | `60000`                     |
| 请求超时           | 行配置 `timeoutMs`                         | `15000`                     |
| 额度计算预算       | 行配置 `contextTimeoutMs`                  | `8000`                      |
| 额度路由缓存       | 行配置 `contextCacheTtlMs`                 | `5000`                      |
| 价目表覆盖         | 行配置 `pricing`                           | 官方 DeepSeek-V4 峰谷价目表 |

行配置写在 profile 的 `cordis.patch.yml`
（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- id: deepseek-quota
  config:
    ttlMs: 30000
    timeoutMs: 10000
    pricing:
      version: my-table-2026-09-01
      tiers:
        deepseek-chat:
          peak:
            cacheHit: 0.12
            cacheMiss: 3.2
            output: 9.5
          offpeak:
            cacheHit: 0.06
            cacheMiss: 1.6
            output: 4.75
      fallbackTier: deepseek-chat
```

`pricing.tiers` 按档位名深合并进默认价目表；`fallbackTier` 决定未知模型按哪档计价。

## 仓库结构

```
dsh-deepseek-quota/
├── package.json          # 清单：dsh.bundle.patch + dsh.client (web)
├── cordis.patch.yml      # bundle 层：插入 deepseek-quota 宿主行
├── lib/
│   ├── index.js          # 宿主编：余额路由 + 会话额度路由（持久日志 fold + 峰谷计价）
│   ├── client.js         # 浏览器端：侧边栏余额 + composer 额度行（React.createElement）
│   └── types/            # 手写 .d.ts，描述公开接口
├── test/
│   └── index.test.js     # 宿主编冒烟测试（node:test，零依赖）
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## 开发

```sh
node test/index.test.js   # 运行宿主编冒烟测试（node:test，零依赖）
```

客户端 bundle 是纯 JavaScript，由 client-modules 系统原样下发——无需构建步骤。
用本地目录（`file:` 依赖）加载插件并重启 `dsh web` 即可生效；浏览器端模块在
刷新页面后热更新。

## License

[MIT](LICENSE)
