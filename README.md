# claude-code-plugin-google-analytics

A comprehensive Claude Code plugin for managing and analyzing data from Google Analytics 4, Google Search Console, and Google Merchant Center directly from the CLI.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

## Quick Start

```bash
git clone https://github.com/your-org/claude-code-plugin-google-analytics.git
cd claude-code-plugin-google-analytics && npm install
node scripts/dist/cli.js get-active-users
```

## Features

- **GA4 Analysis**: Run custom reports, check real-time visitors, and analyze traffic sources.
- **E-commerce Tracking**: Monitor revenue, top-selling products, and conversion metrics.
- **SEO Monitoring**: Access Search Console data for search queries, impressions, and CTR.
- **Indexing Status**: Inspect URLs for indexing issues and rich result eligibility.
- **Product Feed Management**: Check Merchant Center feed status, approvals, and disapprovals.
- **Quick Insights**: Pre-built reports for active users, page views, devices, and geography.
- **Cache Management**: Built-in caching to optimize API quota usage.

## Prerequisites

- **Node.js**: Version 18 or higher (required for native fetch API).
- **Claude Code CLI**: Installed and configured.
- **Google Cloud Credentials**: OAuth 2.0 client credentials with enabled APIs (Analytics Data, Search Console, Content API).

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/claude-code-plugin-google-analytics.git
   ```

2. Install dependencies:
   ```bash
   cd claude-code-plugin-google-analytics
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

This plugin requires OAuth tokens to be stored securely. Ensure your Google Cloud Project has the following scopes enabled:
- `https://www.googleapis.com/auth/analytics.readonly`
- `https://www.googleapis.com/auth/webmasters.readonly`
- `https://www.googleapis.com/auth/content`

Credentials should be located at: `~/.google_workspace_mcp/credentials/{userEmail}.json`

## Available Commands

### Google Analytics 4

| Command | Description |
|---------|-------------|
| `list-accounts` | List all GA4 accounts |
| `list-properties` | List properties |
| `get-property` | Get property details |
| `list-datastreams` | List data streams |
| `run-report` | Custom report |
| `run-realtime` | Real-time data (last 30 min) |
| `get-metadata` | Available metrics/dimensions |
| `get-active-users` | Users, sessions, engagement |
| `get-pageviews` | Top pages by views |
| `get-traffic-sources` | Traffic sources |
| `get-devices` | Device/browser breakdown |
| `get-ecommerce` | E-commerce overview |
| `get-top-products` | Products by revenue |
| `get-geography` | Country/city breakdown |

### Google Search Console

| Command | Description |
|---------|-------------|
| `sc-list-sites` | List verified Search Console sites |
| `sc-search-performance` | Search performance overview |
| `sc-top-queries` | Top search queries driving traffic |
| `sc-top-pages` | Top pages by search performance |
| `sc-query-analytics` | Custom search analytics query |
| `sc-inspect-url` | Full URL inspection |
| `sc-indexing-status` | Simplified indexing status check |

### Google Merchant Center

| Command | Description |
|---------|-------------|
| `mc-feed-summary` | Product feed overview |
| `mc-list-products` | List all product statuses |
| `mc-product-status` | Get status for specific product |
| `mc-disapproved` | List disapproved products |
| `mc-issues` | List all product issues |

### Cache

| Command | Description |
|---------|-------------|
| `cache-stats` | Show cache statistics |
| `cache-clear` | Clear all cached data |
| `cache-invalidate` | Invalidate specific cache key |

## Usage Examples

**Check real-time visitors:**
```bash
node scripts/dist/cli.js run-realtime
```

**Get top 25 search queries driving traffic:**
```bash
node scripts/dist/cli.js sc-top-queries --limit 25
```

**List disapproved products in Merchant Center:**
```bash
node scripts/dist/cli.js mc-disapproved
```

## How it Works

This plugin operates by interfacing directly with Google's official APIs (Analytics Data API, Search Console API, and Content API for Shopping) using Node.js. It handles authentication, executes REST requests, and formats the JSON responses into readable CLI outputs.

## Troubleshooting

1. **Authentication Errors**: Verify that your credential file exists in `~/.google_workspace_mcp/credentials/` and contains valid OAuth tokens.
2. **403 Forbidden**: Check that the Google Cloud Project has the necessary APIs enabled and the user account has access to the specific Property/Merchant ID.
3. **Node Version Issues**: If you encounter syntax errors related to `fetch`, ensure you are using Node.js 18+.
4. **Empty Data**: Ensure the date ranges provided (default is often "Last 7 days") cover periods where actual data exists.

## Contributing

Issues and pull requests are welcome.

## License

MIT
