/**
 * Google Merchant Center API Client
 *
 * Direct client for the Content API for Shopping v2.1.
 * Uses OAuth tokens from the Google Workspace credentials directory for authentication.
 *
 * Key features:
 * - Product feed status overview (approved/disapproved/pending counts)
 * - Individual product status with destination details
 * - Issue tracking and reporting
 * - Automatic pagination for large feeds
 * - Automatic token refresh
 *
 * Note: Uses Content API for Shopping (deprecated August 2026) but fully functional.
 * For product feed status monitoring, this API is simpler than newer alternatives.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Merchant Center API endpoint
const API_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const DEFAULT_TIMEOUT = 30000; // 30 seconds

interface MerchantCenterConfig {
  googleAnalytics: {
    credentialsDir: string;
  };
  merchantCenter: {
    merchantId: string;
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

// Product status types
interface DestinationStatus {
  destination: string;
  status: "approved" | "disapproved" | "pending";
  approvedCountries?: string[];
  pendingCountries?: string[];
  disapprovedCountries?: string[];
}

interface ItemLevelIssue {
  code: string;
  servability: string;
  resolution: string;
  attributeName?: string;
  destination?: string;
  description?: string;
  detail?: string;
  documentation?: string;
  applicableCountries?: string[];
}

interface ProductStatus {
  productId: string;
  title?: string;
  link?: string;
  destinationStatuses?: DestinationStatus[];
  itemLevelIssues?: ItemLevelIssue[];
  creationDate?: string;
  lastUpdateDate?: string;
  googleExpirationDate?: string;
}

interface ProductStatusesListResponse {
  resources?: ProductStatus[];
  nextPageToken?: string;
}

// Feed summary types
interface FeedSummary {
  totalProducts: number;
  approved: number;
  disapproved: number;
  pending: number;
  issueCount: number;
}

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "merchant-center",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class MerchantCenterClient {
  private config: MerchantCenterConfig;
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

    let configFile: MerchantCenterConfig | null = null;
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

  // Get merchant ID (with validation)
  private getMerchantId(): string {
    const merchantId = this.config.merchantCenter?.merchantId;
    if (!merchantId) {
      throw new Error(
        "Merchant ID not configured. Set merchantCenter.merchantId in config.json. " +
          "Find your Merchant ID at https://merchants.google.com/ (top-left of dashboard)."
      );
    }
    return merchantId;
  }

  // Token management (same pattern as analytics-client.ts)
  private async getAccessToken(): Promise<string> {
    try {
      this.tokenData = JSON.parse(readFileSync(this.tokenPath, "utf-8"));
    } catch (error) {
      throw new Error(
        `Failed to read Google OAuth token from ${this.tokenPath}. ` +
          `Ensure you have authenticated with Google Workspace first. ` +
          `Required scope: https://www.googleapis.com/auth/content`
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
        // Non-fatal
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

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

        if (response.status === 429 || response.status === 503) {
          if (attempt < maxRetries) {
            clearTimeout(timeoutId);
            await this.sleep(Math.pow(2, attempt) * 1000);
            continue;
          }
        }

        if (!response.ok) {
          const raw = await response.text();
          let message = raw;
          try {
            const parsed = JSON.parse(raw);
            message = parsed.error?.message ?? raw;
          } catch {
            // Keep raw
          }

          // Provide helpful context for common errors
          if (response.status === 403) {
            throw new Error(
              `Merchant Center access denied (403): ${message}. ` +
                `Verify you have access to merchant ID ${this.getMerchantId()} at https://merchants.google.com/`
            );
          }
          if (response.status === 404) {
            throw new Error(
              `Merchant Center resource not found (404): ${message}. ` +
                `Check the merchant ID or product ID is correct.`
            );
          }

          throw new Error(`Merchant Center API error (${response.status}): ${message}`);
        }

        return response.json() as Promise<T>;
      } catch (e) {
        lastError = e as Error;
        if ((e as Error).name === "AbortError" || (e as Error).message.includes("API error")) {
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

  // ============================================
  // PRODUCT STATUS OPERATIONS
  // ============================================

  /**
   * Lists product statuses with pagination.
   *
   * Returns approval status, destination details, and issues for each product.
   *
   * @param options - Query options
   * @param options.pageSize - Max results per page (max 250)
   * @param options.pageToken - Token for next page
   * @param options.destinations - Filter to specific destinations
   * @returns Response with resources array and nextPageToken
   *
   * @cached TTL: 5 minutes
   */
  async listProductStatuses(options: {
    pageSize?: number;
    pageToken?: string;
    destinations?: string[];
  } = {}): Promise<ProductStatusesListResponse> {
    const merchantId = this.getMerchantId();

    const params = new URLSearchParams();
    if (options.pageSize) params.set("maxResults", String(options.pageSize));
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (options.destinations?.length) {
      options.destinations.forEach((d) => params.append("destinations", d));
    }

    const queryString = params.toString();
    const url = `${API_BASE}/${merchantId}/productstatuses${queryString ? `?${queryString}` : ""}`;

    const cacheKey = createCacheKey("products", {
      merchant: merchantId,
      page: options.pageToken || "first",
      destinations: options.destinations?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      () => this.request<ProductStatusesListResponse>("GET", url),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets status for a specific product.
   *
   * @param productId - Product ID (format: "online:en:GB:SKU123")
   * @returns Product status with destinations and issues
   *
   * @cached TTL: 5 minutes
   */
  async getProductStatus(productId: string): Promise<ProductStatus> {
    const merchantId = this.getMerchantId();
    const cacheKey = createCacheKey("product", { merchant: merchantId, id: productId });

    return cache.getOrFetch(
      cacheKey,
      () =>
        this.request<ProductStatus>(
          "GET",
          `${API_BASE}/${merchantId}/productstatuses/${encodeURIComponent(productId)}`
        ),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // CONVENIENCE METHODS
  // ============================================

  /**
   * Gets product feed summary with approval counts.
   *
   * Fetches all products (paginated) and calculates:
   * - Total products
   * - Approved, disapproved, pending counts
   * - Total issue count
   *
   * @returns Feed summary with counts
   *
   * @cached TTL: 5 minutes
   */
  async getFeedSummary(): Promise<FeedSummary> {
    const cacheKey = createCacheKey("feed-summary", { merchant: this.getMerchantId() });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        // Fetch all products (paginated)
        let allProducts: ProductStatus[] = [];
        let pageToken: string | undefined;

        do {
          const response = await this.listProductStatuses({
            pageSize: 250,
            pageToken,
          });
          if (response.resources) {
            allProducts = allProducts.concat(response.resources);
          }
          pageToken = response.nextPageToken;
        } while (pageToken);

        // Calculate summary
        let approved = 0;
        let disapproved = 0;
        let pending = 0;
        let issueCount = 0;

        for (const product of allProducts) {
          // Check destination statuses
          const hasApproved = product.destinationStatuses?.some(
            (d) => d.status === "approved"
          );
          const hasDisapproved = product.destinationStatuses?.some(
            (d) => d.status === "disapproved"
          );
          const hasPending = product.destinationStatuses?.some(
            (d) => d.status === "pending"
          );

          if (hasDisapproved) disapproved++;
          else if (hasPending) pending++;
          else if (hasApproved) approved++;

          // Count issues
          issueCount += product.itemLevelIssues?.length || 0;
        }

        return {
          totalProducts: allProducts.length,
          approved,
          disapproved,
          pending,
          issueCount,
        };
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets disapproved products only.
   *
   * Useful for identifying products that need attention.
   *
   * @param limit - Max products to return (default: 50)
   * @returns Array of disapproved product statuses with issues
   *
   * @cached TTL: 5 minutes
   */
  async getDisapprovedProducts(limit?: number): Promise<ProductStatus[]> {
    const cacheKey = createCacheKey("disapproved", {
      merchant: this.getMerchantId(),
      limit,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const disapproved: ProductStatus[] = [];
        let pageToken: string | undefined;
        const maxLimit = limit || 50;

        do {
          const response = await this.listProductStatuses({
            pageSize: 250,
            pageToken,
          });

          for (const product of response.resources || []) {
            const isDisapproved = product.destinationStatuses?.some(
              (d) => d.status === "disapproved"
            );
            if (isDisapproved) {
              disapproved.push(product);
              if (disapproved.length >= maxLimit) break;
            }
          }

          pageToken = response.nextPageToken;
        } while (pageToken && disapproved.length < maxLimit);

        return disapproved;
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets all product issues across the feed.
   *
   * Returns flattened list of issues with product context.
   *
   * @param limit - Max issues to return (default: 100)
   * @returns Array of issues with productId, title, and issue details
   *
   * @cached TTL: 5 minutes
   */
  async getProductIssues(limit?: number): Promise<
    Array<{
      productId: string;
      title?: string;
      issue: ItemLevelIssue;
    }>
  > {
    const cacheKey = createCacheKey("issues", {
      merchant: this.getMerchantId(),
      limit,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const issues: Array<{
          productId: string;
          title?: string;
          issue: ItemLevelIssue;
        }> = [];
        let pageToken: string | undefined;
        const maxLimit = limit || 100;

        do {
          const response = await this.listProductStatuses({
            pageSize: 250,
            pageToken,
          });

          for (const product of response.resources || []) {
            for (const issue of product.itemLevelIssues || []) {
              issues.push({
                productId: product.productId,
                title: product.title,
                issue,
              });
              if (issues.length >= maxLimit) break;
            }
            if (issues.length >= maxLimit) break;
          }

          pageToken = response.nextPageToken;
        } while (pageToken && issues.length < maxLimit);

        return issues;
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
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
      { name: "mc-feed-summary", description: "Product feed status overview (approved/disapproved/pending counts)" },
      { name: "mc-list-products", description: "List all product statuses (paginated)" },
      { name: "mc-product-status", description: "Get status for a specific product" },
      { name: "mc-disapproved", description: "List disapproved products" },
      { name: "mc-issues", description: "List all product issues" },
    ];
  }
}

export default MerchantCenterClient;
