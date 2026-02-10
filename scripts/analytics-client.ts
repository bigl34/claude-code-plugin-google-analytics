/**
 * Google Analytics 4 Direct API Client
 *
 * Direct client for the Google Analytics Data API v1beta and Admin API v1beta.
 * Uses OAuth tokens from the Google Workspace credentials directory for authentication.
 * Configuration from config.json with credentials directory and default property ID.
 *
 * Key features:
 * - Admin operations (accounts, properties, data streams)
 * - Custom report builder with metrics, dimensions, and filters
 * - Real-time reporting (last 30 minutes)
 * - Convenience methods for common reports (users, pages, traffic, e-commerce)
 * - Automatic token refresh
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Google Analytics API endpoints
const DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_API_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const DEFAULT_TIMEOUT = 30000; // 30 seconds

interface AnalyticsConfig {
  googleAnalytics: {
    credentialsDir: string;
    defaultPropertyId?: string;
  };
  userEmail: string;
}

interface TokenData {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry?: string;
}

interface ReportResponse {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value: string }>;
    metricValues?: Array<{ value: string }>;
  }>;
  rowCount?: number;
  metadata?: any;
}

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "google-analytics-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class GoogleAnalyticsClient {
  private config: AnalyticsConfig;
  private tokenData: TokenData | null = null;
  private tokenPath: string = "";
  private cacheDisabled: boolean = false;
  private timeout: number = DEFAULT_TIMEOUT;

  constructor() {
    // Try multiple locations for config.json
    const possiblePaths = [
      join(__dirname, "config.json"),
      join(__dirname, "..", "config.json"),
    ];

    let configFile: AnalyticsConfig | null = null;
    for (const path of possiblePaths) {
      try {
        configFile = JSON.parse(readFileSync(path, "utf-8"));
        break;
      } catch {
        continue;
      }
    }

    if (!configFile) {
      throw new Error(`Config file not found. Tried: ${possiblePaths.join(", ")}`);
    }

    if (!configFile.googleAnalytics?.credentialsDir) {
      throw new Error("Missing required config: googleAnalytics.credentialsDir");
    }

    if (!configFile.userEmail) {
      throw new Error("Missing required config: userEmail");
    }

    this.config = configFile;
    this.tokenPath = join(
      this.config.googleAnalytics.credentialsDir,
      `${this.config.userEmail}.json`
    );
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /**
   * Disables caching for all subsequent requests.
   */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /**
   * Re-enables caching after it was disabled.
   */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /**
   * Returns cache statistics including hit/miss counts.
   */
  getCacheStats() {
    return cache.getStats();
  }

  /**
   * Clears all cached data.
   * @returns Number of cache entries cleared
   */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates a specific cache entry by key.
   */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  /**
   * Sets the request timeout.
   * @param ms - Timeout in milliseconds
   */
  setTimeout(ms: number): void {
    this.timeout = ms;
  }

  // ============================================
  // TOKEN MANAGEMENT
  // ============================================
  private async getAccessToken(): Promise<string> {
    // Load token from credentials file
    try {
      this.tokenData = JSON.parse(readFileSync(this.tokenPath, "utf-8"));
    } catch (error) {
      throw new Error(
        `Failed to read Google OAuth token from ${this.tokenPath}. ` +
          `Ensure you have authenticated with Google Workspace first.`
      );
    }

    // Check if token is expired and refresh if needed
    if (this.isTokenExpired()) {
      await this.refreshToken();
    }

    return this.tokenData!.token;
  }

  private isTokenExpired(): boolean {
    if (!this.tokenData?.expiry) return true;
    const expiry = new Date(this.tokenData.expiry);
    // Refresh if less than 5 minutes until expiry
    return expiry.getTime() - Date.now() < 5 * 60 * 1000;
  }

  private async refreshToken(): Promise<void> {
    if (!this.tokenData?.refresh_token) {
      throw new Error("No refresh token available. Re-authentication required.");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.tokenData.client_id,
          client_secret: this.tokenData.client_secret,
          refresh_token: this.tokenData.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${errorText}`);
      }

      const newTokens = await response.json();
      this.tokenData!.token = newTokens.access_token;

      // Calculate new expiry (tokens typically last 1 hour)
      if (newTokens.expires_in) {
        const expiryDate = new Date(Date.now() + newTokens.expires_in * 1000);
        this.tokenData!.expiry = expiryDate.toISOString();
      }

      // Save updated token back to file
      try {
        writeFileSync(this.tokenPath, JSON.stringify(this.tokenData, null, 2));
      } catch {
        // Non-fatal - token still works for this session
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Helper for retry delays
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Generic request method with retry logic
  private async request<T>(
    method: string,
    url: string,
    body?: Record<string, any>
  ): Promise<T> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const accessToken = await this.getAccessToken();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const options: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        };

        if (body) {
          options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        // Retry on transient errors (rate limit or service unavailable)
        if (response.status === 429 || response.status === 503) {
          if (attempt < maxRetries) {
            clearTimeout(timeoutId);
            await this.sleep(Math.pow(2, attempt) * 1000); // 1s, 2s backoff
            continue;
          }
        }

        if (!response.ok) {
          const raw = await response.text();
          let message = raw;
          // Try to extract structured error message from GA API
          try {
            const parsed = JSON.parse(raw);
            message = parsed.error?.message ?? raw;
          } catch {
            // Keep raw text if not JSON
          }
          throw new Error(`GA API error (${response.status}): ${message}`);
        }

        return response.json() as Promise<T>;
      } catch (e) {
        lastError = e as Error;
        // Retry on network errors (but not on API errors)
        if ((e as Error).name === "AbortError" || (e as Error).message.includes("GA API error")) {
          clearTimeout(timeoutId);
          throw e;
        }
        if (attempt < maxRetries) {
          clearTimeout(timeoutId);
          await this.sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  // Helper to resolve property ID
  private resolvePropertyId(propertyId?: string): string {
    const propId = propertyId || this.config.googleAnalytics.defaultPropertyId;
    if (!propId) {
      throw new Error(
        "Property ID required. Specify --property or configure defaultPropertyId."
      );
    }
    // Ensure it has the properties/ prefix
    return propId.startsWith("properties/") ? propId : `properties/${propId}`;
  }

  // ============================================
  // ADMIN API OPERATIONS
  // ============================================

  /**
   * Lists all GA4 accounts accessible to the authenticated user.
   *
   * @returns Object with accounts array
   *
   * @cached TTL: 1 hour
   */
  async listAccounts(): Promise<any> {
    return cache.getOrFetch(
      "accounts",
      () => this.request("GET", `${ADMIN_API_BASE}/accounts`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Lists GA4 properties, optionally filtered by account.
   *
   * @param accountId - Optional account ID to filter by
   * @returns Object with properties array
   *
   * @cached TTL: 1 hour
   */
  async listProperties(accountId?: string): Promise<any> {
    const filter = accountId
      ? `?filter=parent:accounts/${accountId.replace("accounts/", "")}`
      : "";
    const cacheKey = createCacheKey("properties", { account: accountId || "all" });

    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `${ADMIN_API_BASE}/properties${filter}`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets details for a specific property.
   *
   * @param propertyId - GA4 property ID (with or without "properties/" prefix)
   * @returns Property object with details
   *
   * @cached TTL: 1 hour
   */
  async getProperty(propertyId: string): Promise<any> {
    const propId = this.resolvePropertyId(propertyId);
    const cacheKey = createCacheKey("property", { id: propId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `${ADMIN_API_BASE}/${propId}`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Lists data streams for a property.
   *
   * Data streams connect GA4 to data sources (web, iOS, Android).
   *
   * @param propertyId - GA4 property ID
   * @returns Object with data streams array
   *
   * @cached TTL: 1 hour
   */
  async listDataStreams(propertyId: string): Promise<any> {
    const propId = this.resolvePropertyId(propertyId);
    const cacheKey = createCacheKey("datastreams", { property: propId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `${ADMIN_API_BASE}/${propId}/dataStreams`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // DATA API OPERATIONS (REPORTS)
  // ============================================

  /**
   * Runs a custom GA4 report with specified metrics and dimensions.
   *
   * This is the core reporting method. For common reports, use the
   * convenience methods like getActiveUsers(), getPageViews(), etc.
   *
   * @param options - Report configuration
   * @param options.propertyId - GA4 property ID (defaults to configured default)
   * @param options.metrics - Array of metric names (e.g., ["activeUsers", "sessions"])
   * @param options.dimensions - Array of dimension names (e.g., ["date", "country"])
   * @param options.startDate - Start date (YYYY-MM-DD or "7daysAgo", "today")
   * @param options.endDate - End date
   * @param options.limit - Maximum rows to return
   * @param options.offset - Row offset for pagination
   * @param options.dimensionFilter - Filter expression
   * @param options.orderBy - Metric to sort by
   * @param options.orderDesc - Sort descending (default: true)
   * @returns Report response with dimension/metric headers and rows
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * const report = await client.runReport({
   *   metrics: ["sessions", "activeUsers"],
   *   dimensions: ["country"],
   *   startDate: "7daysAgo",
   *   endDate: "today",
   *   orderBy: "sessions"
   * });
   */
  async runReport(options: {
    propertyId?: string;
    metrics: string[];
    dimensions?: string[];
    startDate: string;
    endDate: string;
    limit?: number;
    offset?: number;
    dimensionFilter?: any;
    orderBy?: string;
    orderDesc?: boolean;
  }): Promise<ReportResponse> {
    const propId = this.resolvePropertyId(options.propertyId);

    const cacheKey = createCacheKey("report", {
      property: propId,
      metrics: options.metrics.join(","),
      dimensions: options.dimensions?.join(","),
      start: options.startDate,
      end: options.endDate,
      limit: options.limit,
      offset: options.offset,
      dimensionFilter: options.dimensionFilter ? JSON.stringify(options.dimensionFilter) : undefined,
      orderBy: options.orderBy,
      orderDesc: options.orderDesc,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: any = {
          metrics: options.metrics.map((m) => ({ name: m })),
          dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
        };

        if (options.dimensions) {
          body.dimensions = options.dimensions.map((d) => ({ name: d }));
        }
        if (options.limit) {
          body.limit = options.limit;
        }
        if (options.offset) {
          body.offset = options.offset;
        }
        if (options.dimensionFilter) {
          body.dimensionFilter = options.dimensionFilter;
        }
        if (options.orderBy) {
          body.orderBys = [
            {
              metric: { metricName: options.orderBy },
              desc: options.orderDesc ?? true,
            },
          ];
        }

        return this.request<ReportResponse>(
          "POST",
          `${DATA_API_BASE}/${propId}:runReport`,
          body
        );
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Runs a real-time report for data from the last 30 minutes.
   *
   * Real-time reports show live visitor activity. Note that
   * available metrics/dimensions differ from standard reports.
   *
   * @param options - Report configuration
   * @param options.propertyId - GA4 property ID (defaults to configured default)
   * @param options.metrics - Array of real-time metric names (e.g., ["activeUsers"])
   * @param options.dimensions - Array of real-time dimension names
   * @returns Real-time report data
   *
   * @cached TTL: 1 minute (data changes rapidly)
   *
   * @example
   * const realtime = await client.runRealtimeReport({
   *   metrics: ["activeUsers"],
   *   dimensions: ["country"]
   * });
   */
  async runRealtimeReport(options: {
    propertyId?: string;
    metrics: string[];
    dimensions?: string[];
  }): Promise<any> {
    const propId = this.resolvePropertyId(options.propertyId);

    // Real-time data changes constantly - very short cache
    const cacheKey = createCacheKey("realtime", {
      property: propId,
      metrics: options.metrics.join(","),
      dimensions: options.dimensions?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: any = {
          metrics: options.metrics.map((m) => ({ name: m })),
        };

        if (options.dimensions) {
          body.dimensions = options.dimensions.map((d) => ({ name: d }));
        }

        return this.request(
          "POST",
          `${DATA_API_BASE}/${propId}:runRealtimeReport`,
          body
        );
      },
      { ttl: TTL.MINUTE, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets available metrics and dimensions for a property.
   *
   * Use this to discover what metrics and dimensions can be used
   * in reports. Includes both standard and custom metrics/dimensions.
   *
   * @param propertyId - GA4 property ID (defaults to configured default)
   * @returns Metadata with available metrics and dimensions
   *
   * @cached TTL: 1 day (schema changes rarely)
   */
  async getMetadata(propertyId?: string): Promise<any> {
    const propId = this.resolvePropertyId(propertyId);

    return cache.getOrFetch(
      createCacheKey("metadata", { property: propId }),
      () => this.request("GET", `${DATA_API_BASE}/${propId}/metadata`),
      { ttl: TTL.DAY, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // CONVENIENCE REPORT METHODS
  // ============================================

  /**
   * Gets active users summary for the specified date range.
   *
   * Returns: activeUsers, newUsers, sessions, engagedSessions.
   *
   * @param options - Optional date range
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "7daysAgo")
   * @param options.endDate - End date (default: "today")
   * @returns Report with user engagement metrics
   *
   * @cached TTL: 5 minutes
   */
  async getActiveUsers(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: ["activeUsers", "newUsers", "sessions", "engagedSessions"],
      startDate: options.startDate || "7daysAgo",
      endDate: options.endDate || "today",
    });
  }

  /**
   * Gets top pages by page views.
   *
   * Returns: screenPageViews, engagementRate, averageSessionDuration
   * grouped by pagePath and pageTitle.
   *
   * @param options - Optional date range and limit
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "7daysAgo")
   * @param options.endDate - End date (default: "today")
   * @param options.limit - Max rows to return (default: 10)
   * @returns Report with top pages by view count
   *
   * @cached TTL: 5 minutes
   */
  async getPageViews(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: ["screenPageViews", "engagementRate", "averageSessionDuration"],
      dimensions: ["pagePath", "pageTitle"],
      startDate: options.startDate || "7daysAgo",
      endDate: options.endDate || "today",
      limit: options.limit || 10,
      orderBy: "screenPageViews",
    });
  }

  /**
   * Gets traffic sources breakdown.
   *
   * Returns: sessions, engagedSessions, conversions, activeUsers
   * grouped by sessionSource and sessionMedium (e.g., google/organic).
   *
   * @param options - Optional date range
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "7daysAgo")
   * @param options.endDate - End date (default: "today")
   * @returns Report with traffic sources by session count
   *
   * @cached TTL: 5 minutes
   */
  async getTrafficSources(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: ["sessions", "engagedSessions", "conversions", "activeUsers"],
      dimensions: ["sessionSource", "sessionMedium"],
      startDate: options.startDate || "7daysAgo",
      endDate: options.endDate || "today",
      orderBy: "sessions",
    });
  }

  /**
   * Gets device and browser breakdown.
   *
   * Returns: sessions, activeUsers, engagementRate
   * grouped by deviceCategory, operatingSystem, browser.
   *
   * @param options - Optional date range
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "7daysAgo")
   * @param options.endDate - End date (default: "today")
   * @returns Report with device/browser breakdown
   *
   * @cached TTL: 5 minutes
   */
  async getDeviceBreakdown(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: ["sessions", "activeUsers", "engagementRate"],
      dimensions: ["deviceCategory", "operatingSystem", "browser"],
      startDate: options.startDate || "7daysAgo",
      endDate: options.endDate || "today",
      orderBy: "sessions",
    });
  }

  /**
   * Gets e-commerce overview metrics.
   *
   * Returns aggregate e-commerce KPIs without dimensions:
   * ecommercePurchases, purchaseRevenue, averagePurchaseRevenue,
   * transactions, addToCarts, checkouts.
   *
   * @param options - Optional date range
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "30daysAgo")
   * @param options.endDate - End date (default: "today")
   * @returns Report with e-commerce KPIs
   *
   * @cached TTL: 5 minutes
   */
  async getEcommerceOverview(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: [
        "ecommercePurchases",
        "purchaseRevenue",
        "averagePurchaseRevenue",
        "transactions",
        "addToCarts",
        "checkouts",
      ],
      startDate: options.startDate || "30daysAgo",
      endDate: options.endDate || "today",
    });
  }

  /**
   * Gets top products by revenue.
   *
   * Returns: itemRevenue, itemsPurchased, itemsViewed
   * grouped by itemName and itemId.
   *
   * @param options - Optional date range and limit
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "30daysAgo")
   * @param options.endDate - End date (default: "today")
   * @param options.limit - Max rows to return (default: 20)
   * @returns Report with top products by revenue
   *
   * @cached TTL: 5 minutes
   */
  async getTopProducts(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: ["itemRevenue", "itemsPurchased", "itemsViewed"],
      dimensions: ["itemName", "itemId"],
      startDate: options.startDate || "30daysAgo",
      endDate: options.endDate || "today",
      limit: options.limit || 20,
      orderBy: "itemRevenue",
    });
  }

  /**
   * Gets geographic breakdown of visitors.
   *
   * Returns: sessions, activeUsers, conversions
   * grouped by country and city.
   *
   * @param options - Optional date range and limit
   * @param options.propertyId - GA4 property ID
   * @param options.startDate - Start date (default: "7daysAgo")
   * @param options.endDate - End date (default: "today")
   * @param options.limit - Max rows to return (default: 20)
   * @returns Report with geographic breakdown
   *
   * @cached TTL: 5 minutes
   */
  async getGeography(options: {
    propertyId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  } = {}): Promise<ReportResponse> {
    return this.runReport({
      propertyId: options.propertyId,
      metrics: ["sessions", "activeUsers", "conversions"],
      dimensions: ["country", "city"],
      startDate: options.startDate || "7daysAgo",
      endDate: options.endDate || "today",
      limit: options.limit || 20,
      orderBy: "sessions",
    });
  }

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Returns available CLI commands and their descriptions.
   *
   * Used for help text generation in the CLI.
   *
   * @returns Array of tool definitions with name and description
   */
  getTools(): Array<{ name: string; description: string }> {
    return [
      { name: "list-accounts", description: "List all GA4 accounts" },
      { name: "list-properties", description: "List properties for an account" },
      { name: "get-property", description: "Get property details" },
      { name: "list-datastreams", description: "List data streams for a property" },
      { name: "run-report", description: "Run a custom GA4 report" },
      { name: "run-realtime", description: "Get real-time data (last 30 min)" },
      { name: "get-metadata", description: "Get available metrics/dimensions" },
      { name: "get-active-users", description: "Active users summary" },
      { name: "get-pageviews", description: "Top pages by views" },
      { name: "get-traffic-sources", description: "Traffic source breakdown" },
      { name: "get-devices", description: "Device/browser breakdown" },
      { name: "get-ecommerce", description: "E-commerce overview" },
      { name: "get-top-products", description: "Top products by revenue" },
      { name: "get-geography", description: "Geographic breakdown" },
      { name: "cache-stats", description: "Show cache statistics" },
      { name: "cache-clear", description: "Clear all cached data" },
      { name: "cache-invalidate", description: "Invalidate a specific cache key" },
    ];
  }
}

export default GoogleAnalyticsClient;
