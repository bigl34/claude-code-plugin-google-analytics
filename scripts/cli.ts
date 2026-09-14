#!/usr/bin/env npx tsx

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GoogleAnalyticsClient } from "./analytics-client.js";
import { SearchConsoleClient } from "./search-console-client.js";
import { MerchantCenterClient } from "./merchant-center-client.js";

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

const dimensionFilterSchema = z.string().transform((raw, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dimensionFilter must be valid JSON",
    });
    return z.NEVER;
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dimensionFilter must be a JSON object",
    });
    return z.NEVER;
  }

  return parsed as Record<string, unknown>;
});

export const commands = {
  "cache-stats": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => ({
      ga: clients.ga.getCacheStats(),
      sc: clients.sc.getCacheStats(),
      mc: clients.mc.getCacheStats(),
    }),
    "Show cache statistics",
    { sideEffect: "read" }
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
    "Clear all cached data",
    { sideEffect: "write" }
  ),

  "cache-invalidate": createCommand(
    z.object({
      key: z.string().min(1).describe("Cache key to invalidate"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      const key = args.key as string;
      const invalidated = {
        ga: clients.ga.invalidateCacheKey(key),
        sc: clients.sc.invalidateCacheKey(key),
        mc: clients.mc.invalidateCacheKey(key),
      };
      return {
        success: invalidated.ga || invalidated.sc || invalidated.mc,
        key,
        invalidated,
      };
    },
    "Invalidate a specific cache key",
    { sideEffect: "write" }
  ),

  "list-tools": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => ({
      ga: clients.ga.getTools(),
      sc: clients.sc.getTools(),
      mc: clients.mc.getTools(),
    }),
    "List all available commands",
    { sideEffect: "read" }
  ),

  "list-accounts": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => clients.ga.listAccounts(),
    "List all GA4 accounts",
    { sideEffect: "read" }
  ),

  "list-properties": createCommand(
    z.object({
      account: z.string().optional().describe("Account ID for filtering"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.listProperties(args.account as string | undefined);
    },
    "List GA4 properties",
    { sideEffect: "read" }
  ),

  "get-property": createCommand(
    z.object({
      property: z.string().min(1).describe("GA4 property ID"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getProperty(args.property as string);
    },
    "Get property details",
    { sideEffect: "read" }
  ),

  "list-datastreams": createCommand(
    z.object({
      property: z.string().min(1).describe("GA4 property ID"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.listDataStreams(args.property as string);
    },
    "List data streams for a property",
    { sideEffect: "read" }
  ),

  "run-report": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
      metrics: z.string().min(1).describe("Comma-separated metric names"),
      dimensions: z.string().optional().describe("Comma-separated dimension names"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD or NdaysAgo)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD or 'today')"),
      limit: cliTypes.int(1, 100000).optional().describe("Max rows to return"),
      offset: cliTypes.int(0).optional().describe("Row offset for pagination"),
      dimensionFilter: dimensionFilterSchema.optional().describe("Dimension filter as JSON"),
      orderBy: z.string().optional().describe("Metric to sort by"),
      orderDesc: z.boolean().optional().describe("Sort descending (default: true)"),
    }),
    async (args, clients: GoogleMarketingClients) => {
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
        dimensionFilter: args.dimensionFilter as Record<string, unknown> | undefined,
        orderBy: args.orderBy as string | undefined,
        orderDesc: args.orderDesc !== false,
      });
    },
    "Run a custom GA4 report",
    { sideEffect: "read" }
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
    "Get real-time data (last 30 minutes)",
    { sideEffect: "read" }
  ),

  "get-metadata": createCommand(
    z.object({
      property: z.string().optional().describe("GA4 property ID"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.ga.getMetadata(args.property as string | undefined);
    },
    "Get available metrics and dimensions",
    { sideEffect: "read" }
  ),

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
    "Active/new users and sessions",
    { sideEffect: "read" }
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
    "Top pages by views",
    { sideEffect: "read" }
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
    "Traffic source breakdown",
    { sideEffect: "read" }
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
    "Device/browser breakdown",
    { sideEffect: "read" }
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
    "E-commerce overview (purchases, revenue)",
    { sideEffect: "read" }
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
    "Top products by revenue",
    { sideEffect: "read" }
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
    "Geographic breakdown (country, city)",
    { sideEffect: "read" }
  ),

  "sc-list-sites": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => clients.sc.listSites(),
    "List verified Search Console sites",
    { sideEffect: "read" }
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
    "Search performance overview",
    { sideEffect: "read" }
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
    "Top search queries driving traffic",
    { sideEffect: "read" }
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
    "Top pages by search performance",
    { sideEffect: "read" }
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
    "Custom search analytics query",
    { sideEffect: "read" }
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
    "Full URL inspection (indexing, mobile, rich results)",
    { sideEffect: "read" }
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
    "Simplified indexing status check",
    { sideEffect: "read" }
  ),

  "mc-feed-summary": createCommand(
    z.object({}),
    async (_args, clients: GoogleMarketingClients) => clients.mc.getFeedSummary(),
    "Product feed status overview",
    { sideEffect: "read" }
  ),

  "mc-list-products": createCommand(
    z.object({
      limit: cliTypes.int(1, 1000).optional().describe("Page size"),
      pageToken: z.string().optional().describe("Pagination token"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.listProductStatuses({
        pageSize: args.limit as number | undefined,
        pageToken: args.pageToken as string | undefined,
      });
    },
    "List all product statuses (paginated)",
    { sideEffect: "read" }
  ),

  "mc-product-status": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID (e.g., online:en:GB:SKU123)"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.getProductStatus(args.productId as string);
    },
    "Get status for a specific product",
    { sideEffect: "read" }
  ),

  "mc-disapproved": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.getDisapprovedProducts(args.limit as number | undefined);
    },
    "List disapproved products",
    { sideEffect: "read" }
  ),

  "mc-issues": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max results"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.getProductIssues(args.limit as number | undefined);
    },
    "List all product issues",
    { sideEffect: "read" }
  ),

  "mc-list-data-sources": createCommand(
    z.object({
      limit: cliTypes.int(1, 1000).optional().describe("Page size"),
      pageToken: z.string().optional().describe("Pagination token"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.listDataSources({
        pageSize: args.limit as number | undefined,
        pageToken: args.pageToken as string | undefined,
      });
    },
    "List data sources with latest file upload status",
    { sideEffect: "read" }
  ),

  "mc-account-issues": createCommand(
    z.object({
      limit: cliTypes.int(1, 100).optional().describe("Page size"),
      pageToken: z.string().optional().describe("Pagination token"),
      languageCode: z.string().optional().describe("BMODEL_CODE7 language code"),
      timeZone: z.string().optional().describe("IANA time zone"),
    }),
    async (args, clients: GoogleMarketingClients) => {
      return clients.mc.listAccountIssues({
        pageSize: args.limit as number | undefined,
        pageToken: args.pageToken as string | undefined,
        languageCode: args.languageCode as string | undefined,
        timeZone: args.timeZone as string | undefined,
      });
    },
    "List account-level Merchant Center issues",
    { sideEffect: "read" }
  ),
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(commands, GoogleMarketingClients, {
    programName: "ga-cli",
    description: "Google Analytics, Search Console, and Merchant Center",
  });
}
