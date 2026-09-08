
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadServiceConfig, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { withRetry } from "./vendor/retry/index.js";

const DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_API_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const DEFAULT_TIMEOUT = 30000;

const AnalyticsConfigSchema = z.object({
  userEmail: z.string().min(1),
  googleAnalytics: z.object({
    credentialsDir: z.string().min(1),
    defaultPropertyId: z.string().optional(),
  }),
  searchConsole: z
    .object({
      defaultSiteUrl: z.string().optional(),
    })
    .optional(),
  merchantCenter: z
    .object({
      merchantId: z.string().optional(),
    })
    .optional(),
});

type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;

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
    this.config = loadServiceConfig("google-analytics-manager", {
      schema: AnalyticsConfigSchema,
      remedy:
        "Copy config.template.json to config.json in the google-analytics-manager " +
        "directory and fill in your values.",
    });
    this.tokenPath = join(
      this.config.googleAnalytics.credentialsDir,
      `${this.config.userEmail}.json`
    );
  }


  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    return cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  setTimeout(ms: number): void {
    this.timeout = ms;
  }

  private async getAccessToken(): Promise<string> {
    try {
      this.tokenData = JSON.parse(readFileSync(this.tokenPath, "utf-8"));
    } catch (error) {
      throw new Error(
        `Failed to read Google OAuth token from ${this.tokenPath}. ` +
          `Ensure you have authenticated with Google Workspace first.`
      );
    }

    if (this.isTokenExpired()) {
      await this.refreshToken();
    }

    return this.tokenData!.token;
  }

  private isTokenExpired(): boolean {
    if (!this.tokenData?.expiry) return true;
    const expiry = new Date(this.tokenData.expiry);
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

      if (newTokens.expires_in) {
        const expiryDate = new Date(Date.now() + newTokens.expires_in * 1000);
        this.tokenData!.expiry = expiryDate.toISOString();
      }

      try {
        writeFileSync(this.tokenPath, JSON.stringify(this.tokenData, null, 2));
      } catch {
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(
    method: string,
    url: string,
    body?: Record<string, any>
  ): Promise<T> {
    const maxRetries = 2;
    let attemptIndex = 0;
    const result = await withRetry(
      async () => {
        const attempt = attemptIndex++;
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

          if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
            const error = new Error(`GA API retryable status (${response.status})`);
            (error as Error & { status?: number }).status = response.status;
            throw error;
          }

          if (!response.ok) {
            const raw = await response.text();
            let message = raw;
            try {
              const parsed = JSON.parse(raw);
              message = parsed.error?.message ?? raw;
            } catch {
            }
            const error = new Error(`GA API error (${response.status}): ${message}`);
            (error as Error & { status?: number }).status = response.status;
            throw error;
          }

          return response.json() as Promise<T>;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxRetries,
        baseDelayMs: 1000,
        maxDelayMs: 4000,
        jitterPercent: 0,
        retryableErrors: [],
        nextDelayMs: ({ attempt }) => Math.pow(2, attempt) * 1000,
        shouldRetry: (err) => {
          const status = (err as { status?: unknown } | null | undefined)?.status;
          if (typeof status === "number") {
            return status === 429 || status === 503;
          }
          if (err instanceof Error) {
            return err.name !== "AbortError" && !err.message.includes("GA API error");
          }
          return true;
        },
        sleepImpl: (ms) => this.sleep(ms),
        logger: () => {},
      }
    );

    if (result.success) {
      return result.data as T;
    }

    throw result.error || new Error("Request failed after retries");
  }

  private resolvePropertyId(propertyId?: string): string {
    const propId = propertyId || this.config.googleAnalytics.defaultPropertyId;
    if (!propId) {
      throw new Error(
        "Property ID required. Specify --property or configure defaultPropertyId."
      );
    }
    return propId.startsWith("properties/") ? propId : `properties/${propId}`;
  }


  async listAccounts(): Promise<any> {
    return cache.getOrFetch(
      "accounts",
      () => this.request("GET", `${ADMIN_API_BASE}/accounts`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

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

  async getProperty(propertyId: string): Promise<any> {
    const propId = this.resolvePropertyId(propertyId);
    const cacheKey = createCacheKey("property", { id: propId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `${ADMIN_API_BASE}/${propId}`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async listDataStreams(propertyId: string): Promise<any> {
    const propId = this.resolvePropertyId(propertyId);
    const cacheKey = createCacheKey("datastreams", { property: propId });

    return cache.getOrFetch(
      cacheKey,
      () => this.request("GET", `${ADMIN_API_BASE}/${propId}/dataStreams`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }


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

  async runRealtimeReport(options: {
    propertyId?: string;
    metrics: string[];
    dimensions?: string[];
  }): Promise<any> {
    const propId = this.resolvePropertyId(options.propertyId);

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

  async getMetadata(propertyId?: string): Promise<any> {
    const propId = this.resolvePropertyId(propertyId);

    return cache.getOrFetch(
      createCacheKey("metadata", { property: propId }),
      () => this.request("GET", `${DATA_API_BASE}/${propId}/metadata`),
      { ttl: TTL.DAY, bypassCache: this.cacheDisabled }
    );
  }


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

