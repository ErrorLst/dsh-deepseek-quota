# dsh-deepseek-quota

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
插件：在 Web 界面侧边栏底部实时显示 DeepSeek API 账户余额。

## 功能特性

- **实时余额指示器**：注册在 `sidebar.footer.action` 插槽，每 60 秒轮询一次
  DeepSeek 余额接口，点击可手动刷新。
- **感知布局**：侧边栏展开时显示完整金额，收起为窄栏时只显示紧凑的 `¥` 符号。
- **状态一目了然**：悬停提示展示赠金与充值金额明细；余额不可用时标签变警示色，
  出错时变危险色。
- **零运行时依赖**：宿主编只用 Node 内置能力（全局 `fetch`、
  `AbortSignal.timeout`）与 Cordis 上下文。
- **凭据复用**：通过 `llm-deepseek` 提供方同款的 `credentials` 服务解析
  `DEEPSEEK_API_KEY`，失败时回退到进程环境变量。
- **多标签页缓存合并**：短 TTL 缓存服务并发浏览器标签页；
  `GET /api/deepseek-quota?refresh=1` 可绕过缓存。

## 环境要求

- DeepSeek Harness **web profile**（`dsh web`）——该 bundle 只在 web profile 挂载。
- 通过以下任一方式配置 DeepSeek API Key：
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
`"dsh-deepseek-quota"`（Web 界面自带的插件管理器会自动登记 bundle 层；裸 CLI
只是转发 pnpm，需要手动加）。重启 `dsh web`。

### 本地目录安装（开发调试）

```sh
dsh plugin --profile web add file:C:/path/to/dsh-deepseek-quota
```

同样完成上述 bundle 层登记后重启。

### 从 npm 安装（发布后）

```sh
dsh plugin --profile web add dsh-deepseek-quota
```

### 卸载

```sh
dsh plugin --profile web remove dsh-deepseek-quota
```

并从 profile 的 `package.json` 的 `dsh.profile.bundles` 中移除该名称。

## 使用

打开 Web 界面，余额指示器位于侧边栏底部「设置」按钮旁边。悬停查看赠金/充值
明细，点击强制刷新。

也可以直接访问接口：

```sh
curl http://127.0.0.1:3080/api/deepseek-quota
curl http://127.0.0.1:3080/api/deepseek-quota?refresh=1
```

## HTTP API

`GET /api/deepseek-quota`（由宿主编通过 `webServer` 提供）：

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

## 配置

| 配置项       | 设置方式                                               | 默认值                   |
| ------------ | ------------------------------------------------------ | ------------------------ |
| API 地址     | `DEEPSEEK_BASE_URL` 环境变量，或行配置 `baseURL`       | `https://api.deepseek.com` |
| 缓存 TTL     | 行配置 `ttlMs`                                         | `60000`                  |
| 请求超时     | 行配置 `timeoutMs`                                     | `15000`                  |

行配置写在 profile 的 `cordis.patch.yml`
（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- id: deepseek-quota
  config:
    ttlMs: 30000
    timeoutMs: 10000
```

## 仓库结构

```
dsh-deepseek-quota/
├── package.json          # 清单：dsh.bundle.patch + dsh.client (web)
├── cordis.patch.yml      # bundle 层：插入 deepseek-quota 宿主行
├── lib/
│   ├── index.js          # 宿主编：webServer 路由 + TTL 缓存 + 余额请求
│   ├── client.js         # 浏览器端：侧边栏底部插槽 UI（React.createElement）
│   └── types/            # 手写 .d.ts，描述公开接口
├── test/
│   └── index.test.js     # 宿主编冒烟测试（node:test，零依赖）
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## 开发

```sh
npm test          # 运行宿主编冒烟测试（node --test）
```

客户端 bundle 是纯 JavaScript，由 client-modules 系统原样下发——无需构建步骤。
用本地目录（`file:` 依赖）加载插件并重启 `dsh web` 即可生效；浏览器端模块在
刷新页面后热更新。

## License

[MIT](LICENSE)
