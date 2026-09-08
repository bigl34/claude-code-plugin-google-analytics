
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadServiceConfig, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { GoogleApiResponseError, shouldRetryGoogleApiError } from "./google-api-error.js";

const API_BASE = "https://www.googleapis.com/webmasters/v3";
const URL_INSPECTION_BASE = "https://searchconsole.googleapis.com/v1";
const DEFAULT_TIMEOUT = 30000;

function formatUtcDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function resolveRelativeDate(dateStr: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  const formatRelativeDay = (dayOffset: number): string =>
    formatUtcDate(new Date(Date.UTC(year, month, day + dayOffset)));

  if (dateStr === "today") {
    return formatRelativeDay(0);
  }

  if (dateStr === "yesterday") {
    return formatRelativeDay(-1);
  }

  const daysAgoMatch = dateStr.match(/^(\d+)daysAgo$/i);
  if (daysAgoMatch) {
    const daysAgo = parseInt(daysAgoMatch[1], 10);
    return formatRelativeDay(-daysAgo);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  throw new Error(
    `Invalid date format: ${dateStr}. Use YYYY-MM-DD, 'today', 'yesterday', or 'NdaysAgo'`
  );
}

const SearchConsoleConfigSchema = z.object({
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

type SearchConsoleConfig = z.infer<typeof SearchConsoleConfigSchema>;

interface TokenData {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry?: string;
}

interface SearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: ("date" | "query" | "page" | "country" | "device" | "searchAppearance")[];
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  dimensionFilterGroups?: DimensionFilterGroup[];
  aggregationType?: "auto" | "byPage" | "byProperty";
  rowLimit?: number;
  startRow?: number;
}

interface DimensionFilterGroup {
  groupType?: "and";
  filters: DimensionFilter[];
}

interface DimensionFilter {
  dimension: string;
  operator?: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
  expression: string;
}

interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

interface UrlInspectionResult {
  inspectionResult: {
    inspectionResultLink: string;
    indexStatusResult: {
      verdict: "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL";
      coverageState: string;
      robotsTxtState: string;
      indexingState: string;
      lastCrawlTime?: string;
      pageFetchState: string;
      googleCanonical?: string;
      userCanonical?: string;
      sitemap?: string[];
      referringUrls?: string[];
      crawledAs?: string;
    };
    mobileUsabilityResult?: {
      verdict: string;
      issues?: Array<{ issueType: string; message: string }>;
    };
    richResultsResult?: {
      verdict: string;
      detectedItems?: Array<{ richResultType: string; items: any[] }>;
    };
  };
}

interface Site {
  siteUrl: string;
  permissionLevel: string;
}

interface SitesListResponse {
  siteEntry?: Site[];
}

const cache = new PluginCache({
  namespace: "search-console",
  defaultTTL: TTL.FIFTEEN_MINUTES,
});

export class SearchConsoleClient {
  private config: SearchConsoleConfig;
  private tokenData: TokenData | null = null;
  private tokenPath: string = "";
  private cacheDisabled: boolean = false;
  private timeout: number = DEFAULT_TIMEOUT;

  private parseDate(dateStr: string): string {
    return resolveRelativeDate(dateStr, new Date());
  }

  constructor() {
    this.config = loadServiceConfig("google-analytics-manager", {
      schema: SearchConsoleConfigSchema,
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
          `Ensure you have authenticated with Google Workspace first. ` +
          `Required scope: https://www.googleapis.com/auth/webmasters.readonly`
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

        if (response.status === 429 || response.status === 503) {
          if (attempt < maxRetries) {
            throw new GoogleApiResponseError(
              `Search Console API retryable status (${response.status})`,
              response.status,
            );
          }
        }

        if (!response.ok) {
          const raw = await response.text();
          let message = raw;
          try {
            const parsed = JSON.parse(raw);
            message = parsed.error?.message ?? raw;
          } catch {
          }

          if (response.status === 403) {
            throw new GoogleApiResponseError(
              `Search Console access denied (403): ${message}. ` +
                `Verify site ownership at https://search.google.com/search-console`,
              response.status,
            );
          }
          if (response.status === 400 && message.includes("date")) {
            throw new GoogleApiResponseError(
              `Invalid date range (400): ${message}. ` +
                `Search Console data is only available for the last 16 months.`,
              response.status,
            );
          }

          throw new GoogleApiResponseError(
            `Search Console API error (${response.status}): ${message}`,
            response.status,
          );
        }

        return response.json() as Promise<T>;
      } catch (e) {
        lastError = e as Error;
        if (!shouldRetryGoogleApiError(e)) {
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

  private resolveSiteUrl(siteUrl?: string): string {
    const url = siteUrl || this.config.searchConsole?.defaultSiteUrl;
    if (!url) {
      throw new Error(
        "Site URL required. Specify --site or configure searchConsole.defaultSiteUrl."
      );
    }
    return url;
  }


  async listSites(): Promise<SitesListResponse> {
    return cache.getOrFetch(
      "sites",
      () => this.request<SitesListResponse>("GET", `${API_BASE}/sites`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async getSite(siteUrl: string): Promise<Site> {
    const encodedUrl = encodeURIComponent(this.resolveSiteUrl(siteUrl));
    const cacheKey = createCacheKey("site", { url: siteUrl });

    return cache.getOrFetch(
      cacheKey,
      () => this.request<Site>("GET", `${API_BASE}/sites/${encodedUrl}`),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }


  async querySearchAnalytics(options: {
    siteUrl?: string;
    startDate: string;
    endDate: string;
    dimensions?: ("date" | "query" | "page" | "country" | "device" | "searchAppearance")[];
    type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
    dimensionFilterGroups?: DimensionFilterGroup[];
    aggregationType?: "auto" | "byPage" | "byProperty";
    rowLimit?: number;
    startRow?: number;
  }): Promise<SearchAnalyticsResponse> {
    const siteUrl = this.resolveSiteUrl(options.siteUrl);
    const encodedUrl = encodeURIComponent(siteUrl);

    const cacheKey = createCacheKey("analytics", {
      site: siteUrl,
      start: options.startDate,
      end: options.endDate,
      dimensions: options.dimensions?.join(","),
      type: options.type,
      limit: options.rowLimit,
      offset: options.startRow,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: SearchAnalyticsQuery = {
          startDate: this.parseDate(options.startDate),
          endDate: this.parseDate(options.endDate),
        };

        if (options.dimensions) body.dimensions = options.dimensions;
        if (options.type) body.type = options.type;
        if (options.dimensionFilterGroups) body.dimensionFilterGroups = options.dimensionFilterGroups;
        if (options.aggregationType) body.aggregationType = options.aggregationType;
        if (options.rowLimit) body.rowLimit = options.rowLimit;
        if (options.startRow) body.startRow = options.startRow;

        return this.request<SearchAnalyticsResponse>(
          "POST",
          `${API_BASE}/sites/${encodedUrl}/searchAnalytics/query`,
          body
        );
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getSearchPerformance(options: {
    siteUrl?: string;
    startDate?: string;
    endDate?: string;
    type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  } = {}): Promise<SearchAnalyticsResponse> {
    return this.querySearchAnalytics({
      siteUrl: options.siteUrl,
      startDate: options.startDate || "28daysAgo",
      endDate: options.endDate || "today",
      dimensions: ["date"],
      type: options.type || "web",
      rowLimit: 28,
    });
  }

  async getTopQueries(options: {
    siteUrl?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  } = {}): Promise<SearchAnalyticsResponse> {
    return this.querySearchAnalytics({
      siteUrl: options.siteUrl,
      startDate: options.startDate || "28daysAgo",
      endDate: options.endDate || "today",
      dimensions: ["query"],
      type: options.type || "web",
      rowLimit: options.limit || 25,
    });
  }

  async getTopPages(options: {
    siteUrl?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  } = {}): Promise<SearchAnalyticsResponse> {
    return this.querySearchAnalytics({
      siteUrl: options.siteUrl,
      startDate: options.startDate || "28daysAgo",
      endDate: options.endDate || "today",
      dimensions: ["page"],
      type: options.type || "web",
      rowLimit: options.limit || 25,
    });
  }


  async inspectUrl(options: {
    url: string;
    siteUrl?: string;
    languageCode?: string;
  }): Promise<UrlInspectionResult> {
    const siteUrl = this.resolveSiteUrl(options.siteUrl);

    const cacheKey = createCacheKey("inspect", {
      url: options.url,
      site: siteUrl,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const body: any = {
          inspectionUrl: options.url,
          siteUrl: siteUrl,
        };
        if (options.languageCode) {
          body.languageCode = options.languageCode;
        }

        return this.request<UrlInspectionResult>(
          "POST",
          `${URL_INSPECTION_BASE}/urlInspection/index:inspect`,
          body
        );
      },
      { ttl: TTL.THIRTY_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getIndexingStatus(options: {
    url: string;
    siteUrl?: string;
  }): Promise<{
    url: string;
    isIndexed: boolean;
    verdict: string;
    coverageState: string;
    lastCrawlTime?: string;
    crawledAs?: string;
    googleCanonical?: string;
    issues?: string[];
  }> {
    const result = await this.inspectUrl(options);
    const index = result.inspectionResult.indexStatusResult;

    return {
      url: options.url,
      isIndexed: index.verdict === "PASS",
      verdict: index.verdict,
      coverageState: index.coverageState,
      lastCrawlTime: index.lastCrawlTime,
      crawledAs: index.crawledAs,
      googleCanonical: index.googleCanonical,
      issues: result.inspectionResult.mobileUsabilityResult?.issues?.map(
        (i) => i.message
      ),
    };
  }


  getTools(): Array<{ name: string; description: string }> {
    return [
      { name: "sc-list-sites", description: "List verified Search Console sites" },
      { name: "sc-search-performance", description: "Search performance overview (clicks, impressions, CTR, position)" },
      { name: "sc-top-queries", description: "Top search queries driving traffic" },
      { name: "sc-top-pages", description: "Top pages by search performance" },
      { name: "sc-query-analytics", description: "Custom search analytics query" },
      { name: "sc-inspect-url", description: "Full URL inspection (indexing, mobile, rich results)" },
      { name: "sc-indexing-status", description: "Simplified indexing status check" },
    ];
  }
}

export default SearchConsoleClient;
