#!/usr/bin/env npx tsx
/**
 * Google Analytics & Marketing CLI
 *
 * Zod-validated CLI for GA4, Search Console, and Merchant Center.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { GoogleAnalyticsClient } from "./analytics-client.js";
import { SearchConsoleClient } from "./search-console-client.js";
import { MerchantCenterClient } from "./merchant-center-client.js";

// Wrapper class to hold all three clients
class GoogleMarketingClients {
  ga: GoogleAnalyticsClient;
  sc: SearchConsoleClient;
  mc: MerchantCenterClient;

  constructor() {
    this.ga = new GoogleAnalyticsClient();
    this.sc = new SearchConsoleClient();
    this.mc = new MerchantCenterClient();
  }

  disableCache() {
    this.ga.disableCache();
    this.sc.disableCache();
    this.mc.disableCache();
  }

  setTimeout(timeout: number) {
    this.ga.setTimeout(timeout);
    this.sc.setTimeout(timeout);
    this.mc.setTimeout(timeout);
  }
}

// Define commands with Zod schemas
const commands = {
  // ==================== Cache Commands ====================
  "cache-stats": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => ({
      ga: clients.ga.getCacheStats(),
      sc: clients.sc.getCacheStats(),
      mc: clients.mc.getCacheStats(),
    }),
    "Show cache statistics"
  ),

  "cache-clear": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => ({
      success: true,
      entriesCleared: {
        ga: clients.ga.clearCache(),
        sc: clients.sc.clearCache(),
        mc: clients.mc.clearCache(),
      },
    }),
    "Clear all cached data"
  ),

  "cache-invalidate": createCommand(
    z.object({
      key: z.string().min(1).describe("Cache key to invalidate"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      const key = args.key as string;
      return {
        success:
          clients.ga.invalidateCacheKey(key) ||
          clients.sc.invalidateCacheKey(key) ||
          clients.mc.invalidateCacheKey(key),
        key,
      };
    },
    "Invalidate a specific cache key"
  ),

  "list-tools": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => ({
      ga: clients.ga.getTools(),
      sc: clients.sc.getTools(),
      mc: clients.mc.getTools(),
    }),
    "List all available commands"
  ),

  // ==================== GA4: Account/Property Commands ====================
  "list-accounts": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => clients.ga.listAccounts(),
    "List all GA4 accounts"
  ),

  "list-properties": createCommand(
    z.object({
      account: z.string().optional().describe("Account ID for filtering"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.listProperties(args.account as string | undefined);
    },
    "List GA4 properties"
  ),

  "get-property": createCommand(
    z.object({
      property: z.string().min(1).describe("GA4 property ID"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getProperty(args.property as string);
    },
    "Get property details"
  ),

  "list-datastreams": createCommand(
    z.object({
      property: z.string().min(1).describe("GA4 property ID"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.listDataStreams(args.property as string);
    },
    "List data streams for a property"
  ),

  // ==================== GA4: Report Commands ====================
  "run-report": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      metrics: z.string().min(1).describe("Comma-separated metric names"),
      dimensions: z.string().optional().describe("Comma-separated dimension names"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD or NdaysAgo)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD or 'today')"),
      limit: cliTypes.int(1, 100000).optional().describe("Max rows to return"),
      offset: cliTypes.int(0).optional().describe("Row offset for pagination"),
      dimensionFilter: z.string().optional().describe("Dimension filter as JSON"),
      orderBy: z.string().optional().describe("Metric to sort by"),
      orderDesc: z.boolean().optional().describe("Sort descending (default: true)"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      let dimensionFilter;
      if (args.dimensionFilter) {
        try {
          dimensionFilter = JSON.parse(args.dimensionFilter as string);
        } catch {
          dimensionFilter = args.dimensionFilter;
        }
      }
      return clients.ga.runReport({
        propertyId: args.property as string | undefined,
        metrics: (args.metrics as string).split(",").map((m) => m.trim()),
        dimensions: args.dimensions
          ? (args.dimensions as string).split(",").map((d) => d.trim())
          : undefined,
        startDate: (args.startDate as string | undefined) || "7daysAgo",
        endDate: (args.endDate as string | undefined) || "today",
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        dimensionFilter,
        orderBy: args.orderBy as string | undefined,
        orderDesc: args.orderDesc !== false,
      });
    },
    "Run a custom GA4 report"
  ),

  "run-realtime": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      metrics: z.string().optional().describe("Comma-separated metrics (default: activeUsers)"),
      dimensions: z.string().optional().describe("Comma-separated dimensions"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.runRealtimeReport({
        propertyId: args.property as string | undefined,
        metrics: ((args.metrics as string | undefined) || "activeUsers").split(",").map((m) => m.trim()),
        dimensions: args.dimensions
          ? (args.dimensions as string).split(",").map((d) => d.trim())
          : undefined,
      });
    },
    "Get real-time data (last 30 minutes)"
  ),

  "get-metadata": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getMetadata(args.property as string | undefined);
    },
    "Get available metrics and dimensions"
  ),

  // ==================== GA4: Quick Report Commands ====================
  "get-active-users": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getActiveUsers({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
      });
    },
    "Active/new users and sessions"
  ),

  "get-pageviews": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getPageViews({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        limit: args.limit as number | undefined,
      });
    },
    "Top pages by views"
  ),

  "get-traffic-sources": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getTrafficSources({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
      });
    },
    "Traffic source breakdown"
  ),

  "get-devices": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getDeviceBreakdown({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
      });
    },
    "Device/browser breakdown"
  ),

  "get-ecommerce": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getEcommerceOverview({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
      });
    },
    "E-commerce overview (purchases, revenue)"
  ),

  "get-top-products": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getTopProducts({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        limit: args.limit as number | undefined,
      });
    },
    "Top products by revenue"
  ),

  "get-geography": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getGeography({
        propertyId: args.property as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        limit: args.limit as number | undefined,
      });
    },
    "Geographic breakdown (country, city)"
  ),

  // ==================== Search Console Commands ====================
  "sc-list-sites": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => clients.sc.listSites(),
    "List verified Search Console sites"
  ),

  "sc-search-performance": createCommand(
    z.object({
      site: z.string().optional().describe("Search Console site URL"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("Search type"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.sc.getSearchPerformance({
        siteUrl: args.site as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        type: args.type as any,
      });
    },
    "Search performance overview"
  ),

  "sc-top-queries": createCommand(
    z.object({
      site: z.string().optional().describe("Search Console site URL"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results"),
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("Search type"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.sc.getTopQueries({
        siteUrl: args.site as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        limit: args.limit as number | undefined,
        type: args.type as any,
      });
    },
    "Top search queries driving traffic"
  ),

  "sc-top-pages": createCommand(
    z.object({
      site: z.string().optional().describe("Search Console site URL"),
      startDate: z.string().optional().describe("Start date"),
      endDate: z.string().optional().describe("End date"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results"),
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("Search type"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.sc.getTopPages({
        siteUrl: args.site as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        limit: args.limit as number | undefined,
        type: args.type as any,
      });
    },
    "Top pages by search performance"
  ),

  "sc-query-analytics": createCommand(
    z.object({
      site: z.string().optional().describe("Search Console site URL"),
      startDate: z.string().optional().describe("Start date (default: 28daysAgo)"),
      endDate: z.string().optional().describe("End date (default: today)"),
      dimensions: z.string().optional().describe("Comma-separated dimensions"),
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("Search type"),
      limit: cliTypes.int(1, 25000).optional().describe("Max rows"),
      offset: cliTypes.int(0).optional().describe("Row offset"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.sc.querySearchAnalytics({
        siteUrl: args.site as string | undefined,
        startDate: (args.startDate as string | undefined) || "28daysAgo",
        endDate: (args.endDate as string | undefined) || "today",
        dimensions: args.dimensions
          ? (args.dimensions as string).split(",").map((d) => d.trim()) as any
          : undefined,
        type: args.type as any,
        rowLimit: args.limit as number | undefined,
        startRow: args.offset as number | undefined,
      });
    },
    "Custom search analytics query"
  ),

  "sc-inspect-url": createCommand(
    z.object({
      url: z.string().min(1).describe("URL to inspect"),
      site: z.string().optional().describe("Search Console site URL"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.sc.inspectUrl({
        url: args.url as string,
        siteUrl: args.site as string | undefined,
      });
    },
    "Full URL inspection (indexing, mobile, rich results)"
  ),

  "sc-indexing-status": createCommand(
    z.object({
      url: z.string().min(1).describe("URL to check"),
      site: z.string().optional().describe("Search Console site URL"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.sc.getIndexingStatus({
        url: args.url as string,
        siteUrl: args.site as string | undefined,
      });
    },
    "Simplified indexing status check"
  ),

  // ==================== Merchant Center Commands ====================
  "mc-feed-summary": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => clients.mc.getFeedSummary(),
    "Product feed status overview"
  ),

  "mc-list-products": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Page size"),
      pageToken: z.string().optional().describe("Pagination token"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.listProductStatuses({
        pageSize: args.limit as number | undefined,
        pageToken: args.pageToken as string | undefined,
      });
    },
    "List all product statuses (paginated)"
  ),

  "mc-product-status": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID (e.g., online:en:GB:SKU123)"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.getProductStatus(args.productId as string);
    },
    "Get status for a specific product"
  ),

  "mc-disapproved": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.getDisapprovedProducts(args.limit as number | undefined);
    },
    "List disapproved products"
  ),

  "mc-issues": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.getProductIssues(args.limit as number | undefined);
    },
    "List all product issues"
  ),
};

// Run CLI
runCli(commands, GoogleMarketingClients, {
  programName: "ga-cli",
  description: "Google Analytics, Search Console, and Merchant Center",
});
