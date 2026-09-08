
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadServiceConfig, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { GoogleApiResponseError, shouldRetryGoogleApiError } from "./google-api-error.js";

const MERCHANT_API_BASE = "https://merchantapi.googleapis.com";
const CONTENT_API_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const DEFAULT_TIMEOUT = 30000;

const MerchantCenterConfigSchema = z.object({
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

type MerchantCenterConfig = z.infer<typeof MerchantCenterConfigSchema>;

interface TokenData {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry?: string;
}

export interface DestinationStatus {
  destination: string;
  status: "approved" | "disapproved" | "pending";
  approvedCountries?: string[];
  pendingCountries?: string[];
  disapprovedCountries?: string[];
}

export interface ItemLevelIssue {
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

export interface ProductStatus {
  productId: string;
  title?: string;
  link?: string;
  destinationStatuses?: DestinationStatus[];
  itemLevelIssues?: ItemLevelIssue[];
  creationDate?: string;
  lastUpdateDate?: string;
  googleExpirationDate?: string;
}

export interface ProductStatusesListResponse {
  resources?: ProductStatus[];
  nextPageToken?: string;
}

export interface FeedSummary {
  totalProducts: number;
  approved: number;
  disapproved: number;
  pending: number;
  issueCount: number;
}

interface MerchantDestinationStatus {
  reportingContext?: string;
  approvedCountries?: string[];
  pendingCountries?: string[];
  disapprovedCountries?: string[];
}

interface MerchantItemLevelIssue {
  code?: string;
  severity?: string;
  resolution?: string;
  attribute?: string;
  reportingContext?: string;
  description?: string;
  detail?: string;
  documentation?: string;
  applicableCountries?: string[];
}

interface MerchantProduct {
  name?: string;
  base64EncodedName?: string;
  legacyLocal?: boolean;
  offerId?: string;
  contentLanguage?: string;
  feedLabel?: string;
  productAttributes?: {
    title?: string;
    link?: string;
    [key: string]: unknown;
  };
  productStatus?: {
    destinationStatuses?: MerchantDestinationStatus[];
    itemLevelIssues?: MerchantItemLevelIssue[];
    creationDate?: string;
    lastUpdateDate?: string;
    googleExpirationDate?: string;
  };
}

interface MerchantProductsListResponse {
  products?: MerchantProduct[];
  nextPageToken?: string;
}

interface ContentProductStatusesListResponse {
  resources?: ProductStatus[];
  nextPageToken?: string;
}

interface MerchantDataSource {
  name: string;
  dataSourceId?: string;
  displayName?: string;
  input?: string;
  fileInput?: {
    fileName?: string;
    fileInputType?: string;
    [key: string]: unknown;
  };
  primaryProductDataSource?: {
    feedLabel?: string;
    contentLanguage?: string;
    countries?: string[];
    [key: string]: unknown;
  };
  supplementalProductDataSource?: Record<string, unknown>;
  localInventoryDataSource?: Record<string, unknown>;
  regionalInventoryDataSource?: Record<string, unknown>;
  promotionDataSource?: Record<string, unknown>;
  productReviewDataSource?: Record<string, unknown>;
  merchantReviewDataSource?: Record<string, unknown>;
}

interface MerchantDataSourcesListResponse {
  dataSources?: MerchantDataSource[];
  nextPageToken?: string;
}

interface MerchantFileUpload {
  name?: string;
  dataSourceId?: string;
  processingState?: string;
  issues?: Array<{
    title?: string;
    description?: string;
    code?: string;
    count?: string;
    severity?: string;
    documentationUri?: string;
  }>;
  itemsTotal?: string;
  itemsCreated?: string;
  itemsUpdated?: string;
  uploadTime?: string;
}

export type LatestFileUploadStatus =
  | {
      applicable: false;
      available: false;
      reason: "api_data_source" | "autofeed_data_source" | "not_file_data_source";
    }
  | ({ applicable: true; available: true } & MerchantFileUpload)
  | {
      applicable: true;
      available: false;
      reason: "no_file_upload";
    };

export interface DataSourceStatus {
  name: string;
  dataSourceId: string;
  displayName?: string;
  input?: string;
  type: string;
  fileInput?: {
    fileName?: string;
    fileInputType?: string;
  };
  feedLabel?: string;
  contentLanguage?: string;
  countries?: string[];
  latestFileUpload: LatestFileUploadStatus;
}

export interface DataSourcesListResponse {
  resources: DataSourceStatus[];
  nextPageToken?: string;
}

interface MerchantAccountIssue {
  name?: string;
  title?: string;
  severity?: string;
  impactedDestinations?: Array<{
    reportingContext?: string;
    impacts?: Array<{ regionCode?: string; severity?: string }>;
  }>;
  detail?: string;
  documentationUri?: string;
}

interface MerchantAccountIssuesListResponse {
  accountIssues?: MerchantAccountIssue[];
  nextPageToken?: string;
}

export interface AccountIssue {
  name?: string;
  title?: string;
  severity?: string;
  impactedDestinations?: Array<{
    reportingContext?: string;
    impacts?: Array<{ regionCode?: string; severity?: string }>;
  }>;
  detail?: string;
  documentationUri?: string;
}

export interface AccountIssuesListResponse {
  resources: AccountIssue[];
  nextPageToken?: string;
}

function normalizeEnum(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}

function normalizeReportingContext(value: string | undefined): string {
  if (!value) return "Unknown";
  const legacyDestinations: Record<string, string> = {
    SHOPPING_ADS: "Shopping",
    DISPLAY_ADS: "DisplayAds",
    FREE_LISTINGS: "SurfacesAcrossGoogle",
    FREE_LOCAL_LISTINGS: "LocalSurfacesAcrossGoogle",
  };
  return legacyDestinations[value] ?? value;
}

function canonicalReportingContext(value: string): string {
  const comparable = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    shopping: "SHOPPING_ADS",
    shoppingads: "SHOPPING_ADS",
    displayads: "DISPLAY_ADS",
    surfacesacrossgoogle: "FREE_LISTINGS",
    freelistings: "FREE_LISTINGS",
    localsurfacesacrossgoogle: "FREE_LOCAL_LISTINGS",
    freelocallistings: "FREE_LOCAL_LISTINGS",
    localinventoryads: "LOCAL_INVENTORY_ADS",
  };
  return aliases[comparable] ?? value.toUpperCase();
}

function classifyDestinationStatus(status: MerchantDestinationStatus): DestinationStatus["status"] {
  if (status.disapprovedCountries?.length) return "disapproved";
  if (status.pendingCountries?.length) return "pending";
  if (status.approvedCountries?.length) return "approved";
  return "pending";
}

function normalizeMerchantIssue(issue: MerchantItemLevelIssue): ItemLevelIssue {
  const severity = normalizeEnum(issue.severity);
  const servability =
    severity === "not_impacted" ? "unaffected" : severity ?? "unknown";

  return {
    code: issue.code ?? "unknown",
    servability,
    resolution: normalizeEnum(issue.resolution) ?? "unknown",
    ...(issue.attribute ? { attributeName: issue.attribute } : {}),
    ...(issue.reportingContext
      ? { destination: normalizeReportingContext(issue.reportingContext) }
      : {}),
    ...(issue.description ? { description: issue.description } : {}),
    ...(issue.detail ? { detail: issue.detail } : {}),
    ...(issue.documentation ? { documentation: issue.documentation } : {}),
    ...(issue.applicableCountries
      ? { applicableCountries: issue.applicableCountries }
      : {}),
  };
}

function normalizeMerchantProduct(product: MerchantProduct): ProductStatus {
  const channel = product.legacyLocal ? "local" : "online";
  const productId = [
    channel,
    product.contentLanguage ?? "",
    product.feedLabel ?? "",
    product.offerId ?? product.name?.split("/products/").at(-1) ?? "",
  ].join(":");
  const status = product.productStatus;

  return {
    productId,
    ...(product.productAttributes?.title ? { title: product.productAttributes.title } : {}),
    ...(product.productAttributes?.link ? { link: product.productAttributes.link } : {}),
    destinationStatuses: (status?.destinationStatuses ?? []).map((destination) => ({
      destination: normalizeReportingContext(destination.reportingContext),
      status: classifyDestinationStatus(destination),
      ...(destination.approvedCountries
        ? { approvedCountries: destination.approvedCountries }
        : {}),
      ...(destination.pendingCountries
        ? { pendingCountries: destination.pendingCountries }
        : {}),
      ...(destination.disapprovedCountries
        ? { disapprovedCountries: destination.disapprovedCountries }
        : {}),
    })),
    itemLevelIssues: (status?.itemLevelIssues ?? []).map(normalizeMerchantIssue),
    ...(status?.creationDate ? { creationDate: status.creationDate } : {}),
    ...(status?.lastUpdateDate ? { lastUpdateDate: status.lastUpdateDate } : {}),
    ...(status?.googleExpirationDate
      ? { googleExpirationDate: status.googleExpirationDate }
      : {}),
  };
}

function normalizeContentProduct(product: ProductStatus): ProductStatus {
  return product;
}

function isMerchantProductsListResponse(
  response: MerchantProductsListResponse | ContentProductStatusesListResponse
): response is MerchantProductsListResponse {
  return "products" in response;
}

function dataSourceType(dataSource: MerchantDataSource): string {
  const typeKeys: Array<keyof MerchantDataSource> = [
    "primaryProductDataSource",
    "supplementalProductDataSource",
    "localInventoryDataSource",
    "regionalInventoryDataSource",
    "promotionDataSource",
    "productReviewDataSource",
    "merchantReviewDataSource",
  ];
  return typeKeys.find((key) => dataSource[key] !== undefined) ?? "unknown";
}

function normalizeAccountIssue(issue: MerchantAccountIssue): AccountIssue {
  return {
    ...(issue.name ? { name: issue.name } : {}),
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.severity ? { severity: normalizeEnum(issue.severity) } : {}),
    ...(issue.impactedDestinations
      ? {
          impactedDestinations: issue.impactedDestinations.map((destination) => ({
            ...(destination.reportingContext
              ? { reportingContext: destination.reportingContext }
              : {}),
            ...(destination.impacts
              ? {
                  impacts: destination.impacts.map((impact) => ({
                    ...(impact.regionCode ? { regionCode: impact.regionCode } : {}),
                    ...(impact.severity
                      ? { severity: normalizeEnum(impact.severity) }
                      : {}),
                  })),
                }
              : {}),
          })),
        }
      : {}),
    ...(issue.detail ? { detail: issue.detail } : {}),
    ...(issue.documentationUri
      ? { documentationUri: issue.documentationUri }
      : {}),
  };
}

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
    this.config = loadServiceConfig("google-analytics-manager", {
      schema: MerchantCenterConfigSchema,
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

  private getMerchantId(): string {
    const merchantIdFromConfig = this.config.merchantCenter?.merchantId;
    const merchantIdFromEnv = process.env.MC_MERCHANT_ID;
    const merchantId = merchantIdFromConfig ?? merchantIdFromEnv;
    if (!merchantId) {
      throw new Error(
        "Merchant ID not configured. Set merchantCenter.merchantId in config.json " +
          "or export MC_MERCHANT_ID. " +
          "Find your Merchant ID at https://merchants.google.com/ (top-left of dashboard)."
      );
    }
    return merchantId;
  }

  private useContentApiFallback(): boolean {
    if (process.env.MC_CONTENT_API_FALLBACK !== "1") return false;

    const expiresAt = process.env.MC_CONTENT_API_FALLBACK_UNTIL;
    const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expiry)) {
      throw new Error(
        "MC_CONTENT_API_FALLBACK requires MC_CONTENT_API_FALLBACK_UNTIL as a valid ISO timestamp."
      );
    }
    if (expiry <= Date.now()) {
      throw new Error(
        `MC_CONTENT_API_FALLBACK expired at ${expiresAt}. Complete Merchant API Developer Registration instead.`
      );
    }
    return true;
  }

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
    body?: Record<string, unknown>
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
              `Merchant Center API retryable status (${response.status})`,
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

          if (response.status === 410 && url.startsWith(CONTENT_API_BASE)) {
            throw new GoogleApiResponseError(
              `Content API fallback unavailable (410): ${message}. ` +
                "Content API for Shopping was sunset on 18 August 2026; disable " +
                "MC_CONTENT_API_FALLBACK and complete Merchant API Developer Registration.",
              response.status,
            );
          }

          if (
            response.status === 401
            && /not registered with (?:the )?merchant account/i.test(message)
          ) {
            throw new GoogleApiResponseError(
              `Merchant API project is not registered (401): ${message}. ` +
                `Call developerRegistration:registerGcp for merchant ID ${this.getMerchantId()}, ` +
                "then allow up to five minutes for registration to take effect.",
              response.status,
            );
          }
          if (response.status === 403) {
            if (/has not been used|(?:service|api).*disabled|access not configured/i.test(message)) {
              throw new GoogleApiResponseError(
                `Merchant API is disabled (403): ${message}. Enable ` +
                  "merchantapi.googleapis.com in the OAuth client's Google Cloud project.",
                response.status,
              );
            }
            throw new GoogleApiResponseError(
              `Merchant Center access denied (403): ${message}. ` +
                `Verify the authenticated principal can access merchant ID ${this.getMerchantId()}.`,
              response.status,
            );
          }
          if (response.status === 404) {
            throw new GoogleApiResponseError(
              `Merchant Center resource not found (404): ${message}. ` +
                `Check the merchant ID or product ID is correct.`,
              response.status,
            );
          }

          throw new GoogleApiResponseError(
            `Merchant Center API error (${response.status}): ${message}`,
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


  async listProductStatuses(options: {
    pageSize?: number;
    pageToken?: string;
    destinations?: string[];
  } = {}): Promise<ProductStatusesListResponse> {
    const merchantId = this.getMerchantId();
    const useContentApi = this.useContentApiFallback();

    const params = new URLSearchParams();
    if (options.pageSize) {
      params.set(
        useContentApi ? "maxResults" : "pageSize",
        String(useContentApi ? Math.min(options.pageSize, 250) : Math.min(options.pageSize, 1000))
      );
    }
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (useContentApi && options.destinations?.length) {
      options.destinations.forEach((d) => params.append("destinations", d));
    }

    const queryString = params.toString();
    const url = useContentApi
      ? `${CONTENT_API_BASE}/${merchantId}/productstatuses${queryString ? `?${queryString}` : ""}`
      : `${MERCHANT_API_BASE}/products/v1/accounts/${merchantId}/products${queryString ? `?${queryString}` : ""}`;

    const cacheKey = createCacheKey("products", {
      merchant: merchantId,
      transport: useContentApi ? "content" : "merchant",
      page: options.pageToken || "first",
      pageSize: options.pageSize,
      destinations: options.destinations?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const response = await this.request<
          MerchantProductsListResponse | ContentProductStatusesListResponse
        >("GET", url);
        const resources: ProductStatus[] = isMerchantProductsListResponse(response)
          ? (response.products ?? []).map(normalizeMerchantProduct)
          : (response.resources ?? []).map(normalizeContentProduct);

        if (!useContentApi && options.destinations?.length) {
          const requested = new Set(options.destinations.map(canonicalReportingContext));
          for (const product of resources) {
            product.destinationStatuses = product.destinationStatuses?.filter((status) =>
              requested.has(canonicalReportingContext(status.destination))
            );
            product.itemLevelIssues = product.itemLevelIssues?.filter((issue) =>
              typeof issue.destination === "string"
                && requested.has(canonicalReportingContext(issue.destination))
            );
          }
        }

        return { resources, nextPageToken: response.nextPageToken };
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  private productResourceSegment(productId: string): string {
    const resourceMarker = "/products/";
    if (productId.includes(resourceMarker)) {
      const segment = productId.split(resourceMarker).at(-1);
      if (!segment) throw new Error(`Invalid Merchant API product resource name: ${productId}`);
      return segment;
    }

    const legacyParts = productId.split(":");
    if (legacyParts.length >= 4 && ["online", "local"].includes(legacyParts[0])) {
      const [channel, contentLanguage, feedLabel, ...offerParts] = legacyParts;
      const offerId = offerParts.join(":");
      const nativeId = [
        ...(channel === "local" ? ["local"] : []),
        contentLanguage,
        feedLabel,
        offerId,
      ].join("~");
      return Buffer.from(nativeId, "utf8").toString("base64url");
    }

    if (productId.includes("~")) {
      return Buffer.from(productId, "utf8").toString("base64url");
    }

    if (/^[A-Za-z0-9_-]+$/.test(productId)) return productId;

    throw new Error(
      "Product ID must be a legacy channel:language:feedLabel:offerId ID, " +
        "a Merchant API contentLanguage~feedLabel~offerId ID, or an encoded resource name."
    );
  }

  async getProductStatus(productId: string): Promise<ProductStatus> {
    const merchantId = this.getMerchantId();
    const useContentApi = this.useContentApiFallback();
    const cacheKey = createCacheKey("product", {
      merchant: merchantId,
      transport: useContentApi ? "content" : "merchant",
      id: productId,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        if (useContentApi) {
          const response = await this.request<ProductStatus>(
            "GET",
            `${CONTENT_API_BASE}/${merchantId}/productstatuses/${encodeURIComponent(productId)}`
          );
          return normalizeContentProduct(response);
        }

        const response = await this.request<MerchantProduct | ProductStatus>(
          "GET",
          `${MERCHANT_API_BASE}/products/v1/accounts/${merchantId}/products/${this.productResourceSegment(productId)}`
        );
        return "productId" in response
          ? normalizeContentProduct(response)
          : normalizeMerchantProduct(response);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  private fileUploadNotApplicable(dataSource: MerchantDataSource): LatestFileUploadStatus | null {
    const input = dataSource.input?.toUpperCase();
    if (input === "API") {
      return { applicable: false, available: false, reason: "api_data_source" };
    }
    if (input === "AUTOFEED") {
      return { applicable: false, available: false, reason: "autofeed_data_source" };
    }
    if (input !== "FILE") {
      return { applicable: false, available: false, reason: "not_file_data_source" };
    }
    return null;
  }

  private normalizeFileUpload(upload: MerchantFileUpload): LatestFileUploadStatus {
    return {
      applicable: true,
      available: true,
      ...(upload.name ? { name: upload.name } : {}),
      ...(upload.dataSourceId ? { dataSourceId: upload.dataSourceId } : {}),
      ...(upload.processingState
        ? { processingState: normalizeEnum(upload.processingState) }
        : {}),
      ...(upload.issues
        ? {
            issues: upload.issues.map((issue) => ({
              ...(issue.title ? { title: issue.title } : {}),
              ...(issue.description ? { description: issue.description } : {}),
              ...(issue.code ? { code: issue.code } : {}),
              ...(issue.count ? { count: issue.count } : {}),
              ...(issue.severity ? { severity: normalizeEnum(issue.severity) } : {}),
              ...(issue.documentationUri
                ? { documentationUri: issue.documentationUri }
                : {}),
            })),
          }
        : {}),
      ...(upload.itemsTotal ? { itemsTotal: upload.itemsTotal } : {}),
      ...(upload.itemsCreated ? { itemsCreated: upload.itemsCreated } : {}),
      ...(upload.itemsUpdated ? { itemsUpdated: upload.itemsUpdated } : {}),
      ...(upload.uploadTime ? { uploadTime: upload.uploadTime } : {}),
    };
  }

  private async getLatestFileUpload(
    dataSource: MerchantDataSource
  ): Promise<LatestFileUploadStatus> {
    const notApplicable = this.fileUploadNotApplicable(dataSource);
    if (notApplicable) return notApplicable;

    const merchantId = this.getMerchantId();
    const dataSourceId = dataSource.dataSourceId ?? dataSource.name.split("/").at(-1);
    if (!dataSourceId) {
      throw new Error(`Data source has no usable resource ID: ${dataSource.name}`);
    }

    try {
      const upload = await this.request<MerchantFileUpload>(
        "GET",
        `${MERCHANT_API_BASE}/datasources/v1/accounts/${merchantId}/dataSources/${encodeURIComponent(dataSourceId)}/fileUploads/latest`
      );
      return this.normalizeFileUpload(upload);
    } catch (error) {
      if (error instanceof GoogleApiResponseError && error.status === 404) {
        return { applicable: true, available: false, reason: "no_file_upload" };
      }
      throw error;
    }
  }

  async listDataSources(options: {
    pageSize?: number;
    pageToken?: string;
  } = {}): Promise<DataSourcesListResponse> {
    const merchantId = this.getMerchantId();
    const params = new URLSearchParams();
    if (options.pageSize) params.set("pageSize", String(Math.min(options.pageSize, 1000)));
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const queryString = params.toString();
    const url = `${MERCHANT_API_BASE}/datasources/v1/accounts/${merchantId}/dataSources${queryString ? `?${queryString}` : ""}`;
    const cacheKey = createCacheKey("data-sources", {
      merchant: merchantId,
      page: options.pageToken ?? "first",
      pageSize: options.pageSize,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const response = await this.request<MerchantDataSourcesListResponse>("GET", url);
        const resources: DataSourceStatus[] = [];
        for (const dataSource of response.dataSources ?? []) {
          const primary = dataSource.primaryProductDataSource;
          resources.push({
            name: dataSource.name,
            dataSourceId:
              dataSource.dataSourceId ?? dataSource.name.split("/").at(-1) ?? "",
            ...(dataSource.displayName ? { displayName: dataSource.displayName } : {}),
            ...(dataSource.input ? { input: normalizeEnum(dataSource.input) } : {}),
            type: dataSourceType(dataSource),
            ...(dataSource.fileInput
              ? {
                  fileInput: {
                    ...(dataSource.fileInput.fileName
                      ? { fileName: dataSource.fileInput.fileName }
                      : {}),
                    ...(dataSource.fileInput.fileInputType
                      ? { fileInputType: normalizeEnum(dataSource.fileInput.fileInputType) }
                      : {}),
                  },
                }
              : {}),
            ...(primary?.feedLabel ? { feedLabel: primary.feedLabel } : {}),
            ...(primary?.contentLanguage
              ? { contentLanguage: primary.contentLanguage }
              : {}),
            ...(primary?.countries ? { countries: primary.countries } : {}),
            latestFileUpload: await this.getLatestFileUpload(dataSource),
          });
        }
        return { resources, nextPageToken: response.nextPageToken };
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async listAccountIssues(options: {
    pageSize?: number;
    pageToken?: string;
    languageCode?: string;
    timeZone?: string;
  } = {}): Promise<AccountIssuesListResponse> {
    const merchantId = this.getMerchantId();
    const params = new URLSearchParams();
    params.set("pageSize", String(Math.min(options.pageSize ?? 100, 100)));
    if (options.pageToken) params.set("pageToken", options.pageToken);
    params.set("languageCode", options.languageCode ?? "en-GB");
    params.set("timeZone", options.timeZone ?? "Europe/London");
    const url = `${MERCHANT_API_BASE}/accounts/v1/accounts/${merchantId}/issues?${params.toString()}`;
    const cacheKey = createCacheKey("account-issues", {
      merchant: merchantId,
      page: options.pageToken ?? "first",
      pageSize: options.pageSize ?? 100,
      language: options.languageCode ?? "en-GB",
      timeZone: options.timeZone ?? "Europe/London",
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const response = await this.request<MerchantAccountIssuesListResponse>("GET", url);
        return {
          resources: (response.accountIssues ?? []).map(normalizeAccountIssue),
          nextPageToken: response.nextPageToken,
        };
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async getFeedSummary(): Promise<FeedSummary> {
    const cacheKey = createCacheKey("feed-summary", {
      merchant: this.getMerchantId(),
      transport: this.useContentApiFallback() ? "content" : "merchant",
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const productsById = new Map<string, ProductStatus>();
        let pageToken: string | undefined;

        do {
          const response = await this.listProductStatuses({
            pageSize: 1000,
            pageToken,
          });
          for (const product of response.resources ?? []) {
            productsById.set(product.productId, product);
          }
          pageToken = response.nextPageToken;
        } while (pageToken);

        const allProducts = [...productsById.values()];

        let approved = 0;
        let disapproved = 0;
        let pending = 0;
        let issueCount = 0;

        for (const product of allProducts) {
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

  async getDisapprovedProducts(limit?: number): Promise<ProductStatus[]> {
    const cacheKey = createCacheKey("disapproved", {
      merchant: this.getMerchantId(),
      transport: this.useContentApiFallback() ? "content" : "merchant",
      limit,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const disapproved: ProductStatus[] = [];
        const seenProductIds = new Set<string>();
        let pageToken: string | undefined;
        const maxLimit = limit || 50;

        do {
          const response = await this.listProductStatuses({
            pageSize: 1000,
            pageToken,
          });

          for (const product of response.resources || []) {
            const isDisapproved = product.destinationStatuses?.some(
              (d) => d.status === "disapproved"
            );
            if (isDisapproved && !seenProductIds.has(product.productId)) {
              seenProductIds.add(product.productId);
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

  async getProductIssues(limit?: number): Promise<
    Array<{
      productId: string;
      title?: string;
      issue: ItemLevelIssue;
    }>
  > {
    const cacheKey = createCacheKey("issues", {
      merchant: this.getMerchantId(),
      transport: this.useContentApiFallback() ? "content" : "merchant",
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
            pageSize: 1000,
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


  getTools(): Array<{ name: string; description: string }> {
    return [
      { name: "mc-feed-summary", description: "Product feed status overview (approved/disapproved/pending counts)" },
      { name: "mc-list-products", description: "List all product statuses (paginated)" },
      { name: "mc-product-status", description: "Get status for a specific product" },
      { name: "mc-disapproved", description: "List disapproved products" },
      { name: "mc-issues", description: "List all product issues" },
      { name: "mc-list-data-sources", description: "List data sources with latest file upload status" },
      { name: "mc-account-issues", description: "List account-level Merchant Center issues" },
    ];
  }
}

export default MerchantCenterClient;
