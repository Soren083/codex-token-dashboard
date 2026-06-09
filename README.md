# Codex Token Dashboard

Local dashboard for Codex Desktop and Codex CLI token usage.

It reads local Codex session logs from `~/.codex/sessions/**/*.jsonl`, groups usage by session, model, and day, then estimates cost from the configured pricing table.

## Features

- Token and estimated cost overview
- Daily calendar heatmap with token/cost toggle
- Model-level cost breakdown
- Recent session table
- Date ranges: today, 7 days, 30 days, and all time
- Local-only HTTP server with no runtime dependencies
- Optional macOS LaunchAgent service

## Requirements

- Node.js 18 or newer
- Local Codex session logs under `~/.codex/sessions`

## Quick Start

```bash
git clone https://github.com/Soren083/codex-token-dashboard.git
cd codex-token-dashboard
npm start
```

Open:

```text
http://127.0.0.1:8766/
```

## Configuration

Environment variables:

| Name | Default | Description |
| --- | --- | --- |
| `CODEX_TOKEN_DASHBOARD_HOST` | `127.0.0.1` | HTTP bind host |
| `CODEX_TOKEN_DASHBOARD_PORT` | `8766` | HTTP port |
| `CODEX_TOKEN_DASHBOARD_SESSIONS_ROOT` | `~/.codex/sessions` | Codex session log directory |
| `CODEX_TOKEN_DASHBOARD_PRICING_JSON` | unset | JSON object for overriding model pricing |
| `CODEX_TOKEN_DASHBOARD_CACHE_TTL_MS` | `10000` | In-memory metrics cache TTL |
| `CODEX_TOKEN_DASHBOARD_FILE_CACHE_ENTRIES` | `1000` | Max parsed file cache entries |

Example:

```bash
CODEX_TOKEN_DASHBOARD_PORT=9000 npm start
```

## macOS Service

Install as a user LaunchAgent:

```bash
npm run install-service
```

Uninstall:

```bash
npm run uninstall-service
```

The default LaunchAgent label is `io.github.soren083.codex-token-dashboard`. Override it with:

```bash
CODEX_TOKEN_DASHBOARD_LAUNCHD_LABEL=com.example.codex-token-dashboard npm run install-service
```

## Pricing

Pricing is estimated in USD per 1M tokens.

`input_tokens` includes `cached_input_tokens`, so cost is calculated as:

```text
(input_tokens - cached_input_tokens) * input_rate
+ cached_input_tokens * cached_input_rate
+ output_tokens * output_rate
```

`reasoning_output_tokens` is displayed separately but not billed again because `output_tokens` is used for output billing.

The built-in table includes GPT-5 family rows and a few Codex aliases:

- `gpt-5.2-codex` maps to `gpt-5.2`
- `gpt-5-codex` maps to `gpt-5`
- `gpt-5.3-codex` is shown as token usage but left unpriced unless you provide an override

Use `CODEX_TOKEN_DASHBOARD_PRICING_JSON` when your local model names or pricing differ.

## Privacy

The dashboard reads local session logs and serves the UI on `127.0.0.1` by default. It does not upload usage data anywhere.

Be careful when exposing the server on a public interface because session metadata can include local paths and prompt-derived titles.

## Development

Run checks:

```bash
npm test
node --check server.mjs
```

## License

MIT
