<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-google-analytics

Google Analytics 4, Search Console, and Merchant Center integration

![Version](https://img.shields.io/badge/version-1.5.1-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Account/Property
- **list-accounts** — List all GA4 accounts
- **list-properties** — List properties
- **get-property** — Get property details
- **list-datastreams** — List data streams
- Report
- **run-report** — Custom report
- **run-realtime** — Real-time data (last 30 min)
- **get-metadata** — Available metrics/dimensions
- Quick Reports
- **get-active-users** — Users, sessions, engagement
- **get-pageviews** — Top pages by views
- **get-traffic-sources** — Traffic sources
- **get-devices** — Device/browser breakdown
- **get-ecommerce** — E-commerce overview
- **get-top-products** — Products by revenue
- **get-geography** — Country/city breakdown
- Cache
- **cache-stats** — Show cache statistics (all services)
- **cache-clear** — Clear all cached data (all services)
- **cache-invalidate --key <key>** — Invalidate specific cache
- SEO Performance
- **sc-list-sites** — List verified Search Console sites
- **sc-search-performance** — Search performance overview (clicks, impressions, CTR, position)
- **sc-top-queries** — Top search queries driving traffic
- **sc-top-pages** — Top pages by search performance
- **sc-query-analytics** — Custom search analytics query
- URL Inspection
- **sc-inspect-url** — Full URL inspection (indexing, mobile, rich results)
- **sc-indexing-status** — Simplified indexing status check
- Product Feed Status
- **mc-feed-summary** — Product feed overview (approved/disapproved/pending counts)
- **mc-list-products** — List all product statuses (paginated)
- **mc-product-status** — Get status for specific product
- **mc-disapproved** — List disapproved products
- **mc-issues** — List all product issues

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-google-analytics.git
cd claude-code-plugin-google-analytics
cp scripts/config.template.json scripts/config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- list-accounts
```

## Installation

1. Clone this repository
2. Copy `scripts/config.template.json` to `scripts/config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Configuration

Copy `scripts/config.template.json` to `scripts/config.json` and fill in the required values:

| Field | Placeholder |
|-------|-------------|
| `userEmail` | `you@example.com` |
| `googleAnalytics.credentialsDir` | `/absolute/path/to/google-analytics-credentials` |
| `googleAnalytics.defaultPropertyId` | `YOUR_GA4_PROPERTY_ID` |
| `searchConsole.defaultSiteUrl` | `https://your-domain.example.com/` |
| `merchantCenter.merchantId` | `YOUR_MERCHANT_CENTER_ID` |

## Available Commands

### Account/Property Commands

| Command            | Description           | Required Options       |
| ------------------ | --------------------- | ---------------------- |
| `list-accounts`    | List all GA4 accounts | (none)                 |
| `list-properties`  | List properties       | `--account` (optional) |
| `get-property`     | Get property details  | `--property`           |
| `list-datastreams` | List data streams     | `--property`           |

### Report Commands

| Command        | Description                  | Required Options                             |
| -------------- | ---------------------------- | -------------------------------------------- |
| `run-report`   | Custom report                | `--metrics`                                  |
| `run-realtime` | Real-time data (last 30 min) | `--metrics` (optional, default: activeUsers) |
| `get-metadata` | Available metrics/dimensions | `--property` (optional)                      |

### Quick Reports

| Command               | Description                 | Default Range |
| --------------------- | --------------------------- | ------------- |
| `get-active-users`    | Users, sessions, engagement | Last 7 days   |
| `get-pageviews`       | Top pages by views          | Last 7 days   |
| `get-traffic-sources` | Traffic sources             | Last 7 days   |
| `get-devices`         | Device/browser breakdown    | Last 7 days   |
| `get-ecommerce`       | E-commerce overview         | Last 30 days  |
| `get-top-products`    | Products by revenue         | Last 30 days  |
| `get-geography`       | Country/city breakdown      | Last 7 days   |

### Cache Commands

| Command                        | Description                          |
| ------------------------------ | ------------------------------------ |
| `cache-stats`                  | Show cache statistics (all services) |
| `cache-clear`                  | Clear all cached data (all services) |
| `cache-invalidate --key <key>` | Invalidate specific cache            |

### SEO Performance

| Command                 | Description                                                      | Options                                                                     |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `sc-list-sites`         | List verified Search Console sites                               | (none)                                                                      |
| `sc-search-performance` | Search performance overview (clicks, impressions, CTR, position) | `--site`, `--start-date`, `--end-date`, `--type`                            |
| `sc-top-queries`        | Top search queries driving traffic                               | `--site`, `--start-date`, `--end-date`, `--limit`, `--type`                 |
| `sc-top-pages`          | Top pages by search performance                                  | `--site`, `--start-date`, `--end-date`, `--limit`, `--type`                 |
| `sc-query-analytics`    | Custom search analytics query                                    | `--site`, `--start-date`, `--end-date`, `--dimensions`, `--limit`, `--type` |

### URL Inspection

| Command              | Description                                          | Required Options |
| -------------------- | ---------------------------------------------------- | ---------------- |
| `sc-inspect-url`     | Full URL inspection (indexing, mobile, rich results) | `--url`          |
| `sc-indexing-status` | Simplified indexing status check                     | `--url`          |

### Product Feed Status

| Command             | Description                                                 | Options                   |
| ------------------- | ----------------------------------------------------------- | ------------------------- |
| `mc-feed-summary`   | Product feed overview (approved/disapproved/pending counts) | (none)                    |
| `mc-list-products`  | List all product statuses (paginated)                       | `--limit`, `--page-token` |
| `mc-product-status` | Get status for specific product                             | `--product-id` (required) |
| `mc-disapproved`    | List disapproved products                                   | `--limit`                 |
| `mc-issues`         | List all product issues                                     | `--limit`                 |

### Search Console Options

| Option                | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `--site <url>`        | Site URL (default: https://your-company.com/)                          |
| `--url <url>`         | URL to inspect                                                         |
| `--type <type>`       | Search type: `web`, `image`, `video`, `news`, `discover`, `googleNews` |
| `--dimensions <list>` | Comma-separated: `date`, `query`, `page`, `country`, `device`          |

### Merchant Center Options

| Option                 | Description                                |
| ---------------------- | ------------------------------------------ |
| `--product-id <id>`    | Product ID (format: `online:en:GB:SKU123`) |
| `--limit <n>`          | Max products to return                     |
| `--page-token <token>` | Pagination token for next page             |

### Common Options

| Option                      | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `--property <id>`           | GA4 property ID (e.g., "properties/123456789" or just "123456789") |
| `--start-date <date>`       | Start date (YYYY-MM-DD or "7daysAgo")                              |
| `--end-date <date>`         | End date (YYYY-MM-DD or "today")                                   |
| `--metrics <list>`          | Comma-separated metrics                                            |
| `--dimensions <list>`       | Comma-separated dimensions                                         |
| `--dimension-filter <json>` | GA4 dimension filter as JSON                                       |
| `--limit <n>`               | Max rows to return                                                 |
| `--offset <n>`              | Row offset for pagination                                          |
| `--order-by <metric>`       | Metric to sort by (metrics only, not dimensions)                   |
| `--timeout <ms>`            | Request timeout in milliseconds (default: 30000)                   |
| `--no-cache`                | Bypass cache for fresh data                                        |

## Usage Examples

```bash
# Check real-time visitors
npm --prefix "scripts" run cli -- run-realtime

# Get last 30 days of e-commerce data
npm --prefix "scripts" run cli -- get-ecommerce --start-date 30daysAgo

# Top 20 pages this week
npm --prefix "scripts" run cli -- get-pageviews --limit 20

# Custom report: daily sessions and conversions
npm --prefix "scripts" run cli -- run-report --metrics "sessions,conversions" --dimensions "date" --start-date 7daysAgo
```

```bash
# List verified sites
npm --prefix "scripts" run cli -- sc-list-sites

# Top 25 search queries driving traffic
npm --prefix "scripts" run cli -- sc-top-queries --limit 25

# Check indexing status for a specific page
npm --prefix "scripts" run cli -- sc-indexing-status --url "https://your-company.com/products/YOUR_COMPANY-x1"

# Full URL inspection (indexing, mobile, rich results)
npm --prefix "scripts" run cli -- sc-inspect-url --url "https://your-company.com/"

# Search performance by country
npm --prefix "scripts" run cli -- sc-query-analytics --dimensions "country" --start-date 28daysAgo
```

```bash
# Get product feed summary (approved/disapproved/pending counts)
npm --prefix "scripts" run cli -- mc-feed-summary

# List all disapproved products
npm --prefix "scripts" run cli -- mc-disapproved

# List all product issues
npm --prefix "scripts" run cli -- mc-issues --limit 50

# Get status for specific product
npm --prefix "scripts" run cli -- mc-product-status --product-id "online:en:GB:YOUR_COMPANY-X1"
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
