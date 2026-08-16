# dsh-deepseek-quota

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
plugin that shows your DeepSeek API account balance in real time in the web
UI's sidebar footer.

![status: works in the web profile](https://img.shields.io/badge/dsh-web%20profile-works-2ea44f)

## Features

- **Real-time balance indicator** in the `sidebar.footer.action` slot — polls
  the DeepSeek balance endpoint every 60s and refreshes on click.
- **Layout aware** — renders the full amount when the sidebar is wide, a
  compact `¥` symbol on the collapsed rail.
- **At-a-glance state** — hover tooltip shows the granted vs. topped-up
  breakdown; the label turns warning-colored when the balance is unavailable
  and danger-colored on errors.
- **Zero runtime dependencies** — the host half uses only Node built-ins
  (global `fetch`, `AbortSignal.timeout`) and the Cordis context.
- **Credential seam** — resolves `DEEPSEEK_API_KEY` through the same
  `credentials` service the `llm-deepseek` provider uses, falling back to the
  process environment.
- **Tab-coalesced cache** — a short TTL cache serves concurrent browser tabs;
  `GET /api/deepseek-quota?refresh=1` bypasses it.

## Requirements

- A DeepSeek Harness **web profile** (`dsh web`) — the bundle only mounts in
  the web profile.
- A DeepSeek API key configured in one of:
  - **Settings > Models** in the web UI, or
  - `~/.dsh/.credentials.yaml` (`DEEPSEEK_API_KEY`), or
  - the `DEEPSEEK_API_KEY` environment variable.

## Installation

The plugin is a **bundle plugin**: an npm package whose manifest declares
`dsh.bundle` and whose `cordis.patch.yml` layer is composed into the profile.

### From a Git repository

```sh
dsh plugin --profile web add git+https://github.com/<your-name>/dsh-deepseek-quota.git
```

Then make sure `"dsh-deepseek-quota"` is listed in `dsh.profile.bundles` in
`$DSH_HOME/profiles/web/package.json` (the web UI's plugin manager registers
the bundle layer automatically; the raw CLI only runs pnpm). Restart
`dsh web`.

### From a local checkout (development)

```sh
dsh plugin --profile web add file:C:/path/to/dsh-deepseek-quota
```

…and the same bundle-layer step as above, then restart.

### From npm (once published)

```sh
dsh plugin --profile web add dsh-deepseek-quota
```

### Uninstalling

```sh
dsh plugin --profile web remove dsh-deepseek-quota
```

…and drop the name from `dsh.profile.bundles` in the profile's `package.json`.

## Usage

Open the web UI. The quota indicator sits in the sidebar footer next to the
Settings trigger. Hover it for the granted/topped-up breakdown; click it to
force a refresh.

You can also hit the endpoint directly:

```sh
curl http://127.0.0.1:3080/api/deepseek-quota
curl http://127.0.0.1:3080/api/deepseek-quota?refresh=1
```

## HTTP API

`GET /api/deepseek-quota` (served by the host half through `webServer`):

```jsonc
// success
{
  "ok": true,
  "isAvailable": true,
  "balances": [
    { "currency": "CNY", "total": "123.45", "granted": "10.00", "toppedUp": "113.45" }
  ],
  "fetchedAt": 1735689600000
}

// failure — code is one of:
//   MISSING_KEY  no API key configured
//   AUTH         DeepSeek rejected the key (HTTP 401)
//   HTTP_<status>  other upstream HTTP errors
//   TRANSPORT    network/timeout errors
{ "ok": false, "code": "MISSING_KEY", "message": "DEEPSEEK_API_KEY 未配置：…" }
```

`GET /api/deepseek-quota?refresh=1` bypasses the TTL cache. Non-GET requests
receive `405`.

## Configuration

| Setting       | How                                                            | Default                  |
| ------------- | -------------------------------------------------------------- | ------------------------ |
| API base URL  | `DEEPSEEK_BASE_URL` env var, or `baseURL` row config           | `https://api.deepseek.com` |
| Cache TTL     | `ttlMs` row config                                             | `60000`                  |
| Request timeout | `timeoutMs` row config                                       | `15000`                  |

Row config lives in your profile's `cordis.patch.yml`
(`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: deepseek-quota
  config:
    ttlMs: 30000
    timeoutMs: 10000
```

## Repository layout

```
dsh-deepseek-quota/
├── package.json          # manifest: dsh.bundle.patch + dsh.client (web)
├── cordis.patch.yml      # bundle layer: inserts the deepseek-quota host row
├── lib/
│   ├── index.js          # host half: webServer route + TTL cache + balance fetch
│   ├── client.js         # browser half: sidebar footer slot UI (React.createElement)
│   └── types/            # hand-written .d.ts for the public surface
├── test/
│   └── index.test.js     # host half smoke tests (node:test, zero deps)
├── README.md / README.zh.md
├── CHANGELOG.md
└── LICENSE
```

## Development

```sh
npm test          # run the host half smoke tests (node --test)
```

The client bundle is plain JavaScript served raw by the client-modules system
— no build step. Load the plugin from a local checkout (`file:` dependency)
and restart `dsh web` to pick up changes; the web app hot-reloads client
module content on page refresh.

## License

[MIT](LICENSE)
