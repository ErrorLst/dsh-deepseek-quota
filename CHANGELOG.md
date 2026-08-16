# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-06-XX

### Added

- Host half: `GET /api/deepseek-quota` route on the web profile's `webServer`,
  resolving the API key through the `credentials` service (falling back to the
  environment), with a short TTL cache and `refresh=1` bypass.
- Browser half: real-time DeepSeek balance indicator in the
  `sidebar.footer.action` slot (60s polling, click to refresh, wide/rail
  layouts, granted/topped-up tooltip, warning/danger states).
- Bundle manifest: `dsh.bundle.patch` (`cordis.patch.yml`) and
  `dsh.client` (platform `web`).
- Repository scaffolding: README (EN/ZH), LICENSE, CHANGELOG, .gitignore,
  .editorconfig, type declarations, and zero-dependency smoke tests.
