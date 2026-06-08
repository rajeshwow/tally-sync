import axios, { AxiosError } from "axios";

const CRM_BASE_URL = process.env.CRM_BASE_URL;
const CRM_TENANT_SLUG = process.env.CRM_TENANT_SLUG;
const TALLY_AGENT_TOKEN = process.env.TALLY_AGENT_TOKEN;
const CRM_REQUEST_TIMEOUT_MS = Number(
  process.env.CRM_REQUEST_TIMEOUT_MS || 300000,
);

if (!CRM_BASE_URL) {
  throw new Error("[CRM CLIENT] CRM_BASE_URL is missing in .env");
}

if (!CRM_TENANT_SLUG) {
  throw new Error("[CRM CLIENT] CRM_TENANT_SLUG is missing in .env");
}

if (!TALLY_AGENT_TOKEN) {
  throw new Error("[CRM CLIENT] TALLY_AGENT_TOKEN is missing in .env");
}

const client = axios.create({
  baseURL: `${CRM_BASE_URL.replace(/\/$/, "")}/${CRM_TENANT_SLUG}`,
  timeout: CRM_REQUEST_TIMEOUT_MS,
  headers: {
    Authorization: `Bearer ${TALLY_AGENT_TOKEN}`,
    "Content-Type": "application/json",
  },
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

type SyncMode = "historical" | "incremental";

export type PushProgressEvent = {
  type:
    | "module_start"
    | "batch_start"
    | "batch_success"
    | "batch_failed"
    | "module_complete";
  moduleName: string;
  companyName?: string | null;
  companyGuid?: string | null;
  syncMode: SyncMode;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords: number;
  batchSize: number;
  totalBatches: number;
  batchNo?: number;
  batchRecords?: number;
  uploadedRecords: number;
  pendingRecords: number;
  failedRecords: number;
  uploadedBatches: number;
  failedBatches: number;
  errorMessage?: string | null;
};

type PushOptions = {
  batchSize?: any;
  companyName?: string;
  companyGuid?: string | null;
  moduleName?: string;
  syncMode?: SyncMode;
  fromDate?: string | null;
  toDate?: string | null;
  onProgress?: (event: PushProgressEvent) => void;
};

function chunkArray<T>(records: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < records.length; i += size) {
    chunks.push(records.slice(i, i + size));
  }

  return chunks;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBatchSize(value: any, fallback = 20) {
  const batchSize = Number(value);

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    return fallback;
  }

  return Math.floor(batchSize);
}

function buildCrmPayload(input: {
  moduleName: string;
  batch: any[];
  meta: Record<string, any>;
}) {
  const payload: Record<string, any> = {
    records: input.batch,
    meta: input.meta,
  };

  /**
   * Keep records as primary payload.
   * Add backward-compatible aliases only for transaction modules so existing
   * backend handlers that read module-specific arrays also work.
   */
  if (input.moduleName === "sales-orders") {
    payload.salesOrders = input.batch;
    payload.sales_orders = input.batch;
    payload.orders = input.batch;
  }

  if (input.moduleName === "purchase-orders") {
    payload.purchaseOrders = input.batch;
    payload.purchase_orders = input.batch;
    payload.orders = input.batch;
  }

  if (input.moduleName === "outstandings") {
    payload.outstandings = input.batch;
    payload.outstandingRecords = input.batch;
    payload.outstanding_records = input.batch;
  }

  return payload;
}

function extractCrmSyncCounts(response: any) {
  const data = response?.data || response || {};

  const total = Number(
    data.total ??
      data.totalRecords ??
      data.total_records ??
      data.totalCount ??
      data.total_count ??
      data.count ??
      0,
  );

  const success = Number(
    data.success ??
      data.successCount ??
      data.success_count ??
      data.inserted ??
      data.updated ??
      data.upserted ??
      data.synced ??
      data.saved ??
      0,
  );

  const failed = Number(
    data.failed ?? data.failedCount ?? data.failed_count ?? data.errors ?? 0,
  );

  return {
    total: Number.isFinite(total) ? total : 0,
    success: Number.isFinite(success) ? success : 0,
    failed: Number.isFinite(failed) ? failed : 0,
    jobId: data.job_id || data.jobId || null,
  };
}

function shouldStrictlyValidateModule(moduleName: string) {
  return ["sales-orders", "purchase-orders", "outstandings"].includes(
    moduleName,
  );
}

function validateCrmBatchResult(input: {
  moduleName: string;
  batchLabel: string;
  batchRecords: number;
  response: any;
}) {
  if (!shouldStrictlyValidateModule(input.moduleName)) return;

  const counts = extractCrmSyncCounts(input.response);

  console.log(
    `[CRM CLIENT] ${input.moduleName} batch ${input.batchLabel} CRM result`,
    {
      total: counts.total,
      success: counts.success,
      failed: counts.failed,
      jobId: counts.jobId,
    },
  );

  if (input.batchRecords > 0 && counts.failed > 0) {
    throw new Error(
      `[CRM CLIENT] ${input.moduleName} batch ${input.batchLabel} was accepted by CRM but ${counts.failed}/${counts.total || input.batchRecords} records failed in backend. JobId=${counts.jobId || "N/A"}. Check CRM tally_sync_errors for exact DB error.`,
    );
  }

  if (input.batchRecords > 0 && counts.total > 0 && counts.success === 0) {
    throw new Error(
      `[CRM CLIENT] ${input.moduleName} batch ${input.batchLabel} inserted 0/${counts.total} records in backend. JobId=${counts.jobId || "N/A"}. Check CRM tally_sync_errors for exact DB error.`,
    );
  }
}

async function postWithRetry(
  url: string,
  body: any,
  attempt = 1,
): Promise<any> {
  try {
    const response = await client.post(url, body);
    return response.data;
  } catch (error) {
    const err = error as AxiosError<any>;

    const status = err.response?.status;
    const canRetry =
      attempt < 3 &&
      (!status || status === 408 || status === 429 || status >= 500);

    console.error("[CRM CLIENT] Push failed", {
      url,
      attempt,
      status,
      message: err.message,
      response: err.response?.data,
    });

    if (canRetry) {
      await sleep(200 * attempt);
      return postWithRetry(url, body, attempt + 1);
    }

    throw error;
  }
}

async function pushRecordsToCrm(
  url: string,
  records: any[],
  options: PushOptions = {},
) {
  const safeRecords = Array.isArray(records) ? records : [];
  const batchSize = normalizeBatchSize(options.batchSize, 20);
  const batches = chunkArray(safeRecords, batchSize);
  const moduleName = options.moduleName || url;

  const summary = {
    moduleName,
    companyName: options.companyName || null,
    companyGuid: options.companyGuid || null,
    syncMode: options.syncMode || "incremental",
    fromDate: options.fromDate || null,
    toDate: options.toDate || null,
    totalRecords: safeRecords.length,
    batchSize,
    totalBatches: batches.length,
    successBatches: 0,
    failedBatches: 0,
    uploadedRecords: 0,
    failedRecords: 0,
    pendingRecords: safeRecords.length,
    results: [] as any[],
  };

  const emitProgress = (event: Partial<PushProgressEvent>) => {
    options.onProgress?.({
      type: event.type || "batch_start",
      moduleName,
      companyName: options.companyName || null,
      companyGuid: options.companyGuid || null,
      syncMode: options.syncMode || "incremental",
      fromDate: options.fromDate || null,
      toDate: options.toDate || null,
      totalRecords: safeRecords.length,
      batchSize,
      totalBatches: batches.length,
      uploadedRecords: summary.uploadedRecords,
      pendingRecords: summary.pendingRecords,
      failedRecords: summary.failedRecords,
      uploadedBatches: summary.successBatches,
      failedBatches: summary.failedBatches,
      ...event,
    });
  };

  emitProgress({ type: "module_start" });

  const company = options.companyName ? ` [${options.companyName}]` : "";

  console.log(
    `[SYNC]${company} ${moduleName.padEnd(18)} → ${safeRecords.length} records, ${batches.length} batches`,
  );

  if (!safeRecords.length) {
    emitProgress({ type: "module_complete" });
    return summary;
  }

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const batchNo = index + 1;

    const batchLabel = `${batchNo}/${batches.length}`;

    console.log(
      `[SYNC]${company} ${moduleName.padEnd(18)} ⏳ Batch ${batchLabel} — ${batch.length} records`,
    );

    emitProgress({
      type: "batch_start",
      batchNo,
      batchRecords: batch.length,
    });

    try {
      const meta = {
        company_name: options.companyName || null,
        company_guid: options.companyGuid || null,
        module_name: options.moduleName || null,
        sync_mode: options.syncMode || "incremental",
        from_date: options.fromDate || null,
        to_date: options.toDate || null,
        batch_no: batchNo,
        total_batches: batches.length,
        batch_size: batch.length,
      };

      const result = await postWithRetry(
        url,
        buildCrmPayload({ moduleName, batch, meta }),
      );

      validateCrmBatchResult({
        moduleName,
        batchLabel,
        batchRecords: batch.length,
        response: result,
      });

      const crmCounts = extractCrmSyncCounts(result);
      const uploadedRecordCount = crmCounts.success || batch.length;

      summary.successBatches += 1;
      summary.uploadedRecords += uploadedRecordCount;
      summary.pendingRecords = Math.max(
        safeRecords.length - summary.uploadedRecords - summary.failedRecords,
        0,
      );
      summary.results.push(result);

      console.log(
        `[SYNC]${company} ${moduleName.padEnd(18)} ✅ Batch ${batchLabel} done — ${summary.uploadedRecords}/${safeRecords.length} records uploaded`,
      );

      emitProgress({
        type: "batch_success",
        batchNo,
        batchRecords: batch.length,
        totalRecords: safeRecords.length,
        uploadedRecords: summary.uploadedRecords,
        pendingRecords: summary.pendingRecords,
      });
    } catch (error: any) {
      summary.failedBatches += 1;
      summary.failedRecords += batch.length;
      summary.pendingRecords = Math.max(
        safeRecords.length - summary.uploadedRecords - summary.failedRecords,
        0,
      );

      emitProgress({
        type: "batch_failed",
        batchNo,
        batchRecords: batch.length,
        errorMessage: error?.message || "CRM batch push failed",
      });

      throw error;
    }
  }

  emitProgress({ type: "module_complete" });

  console.log(
    `[SYNC]${company} ${moduleName.padEnd(18)} ✔ Complete — ${summary.uploadedRecords}/${safeRecords.length} records, ${summary.successBatches}/${batches.length} batches`,
  );

  return summary;
}

export async function pushLedgersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/ledgers", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "ledgers",
  });
}

export async function pushStockItemsToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/stock-items", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "stock-items",
  });
}

export async function pushOutstandingsToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/outstandings", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "outstandings",
  });
}

export async function pushSalesOrdersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/sales-orders", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "sales-orders",
  });
}

export async function pushPurchaseOrdersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/purchase-orders", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "purchase-orders",
  });
}

export async function pushCostCentersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/cost-centers", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "cost-centers",
  });
}

export async function updateTallyConnectionInCrm(input: {
  companyName?: string | null;
  companyGuid?: string | null;
  tallyUrl?: string | null;
  direction?: "pull" | "push";
  frequencyMinutes?: number;
  isActive?: boolean;
}) {
  const response = await client.post("/tally/agent/company", {
    company_name: input.companyName || null,
    company_guid: input.companyGuid || null,
    tally_url: input.tallyUrl || process.env.TALLY_URL || null,
    direction: input.direction || "pull",
    frequency_minutes: input.frequencyMinutes || 10,
    is_active: input.isActive ?? true,
  });

  return response.data;
}

export async function getTallySyncStateFromCrm(input: {
  companyName?: string | null;
  companyGuid?: string | null;
}) {
  const response = await client.get("/tally/agent/sync-state", {
    params: {
      company_name: input.companyName || undefined,
      company_guid: input.companyGuid || undefined,
    },
  });

  return response.data;
}

export async function updateTallySyncStateInCrm(input: {
  companyName?: string | null;
  companyGuid?: string | null;
  syncMode: SyncMode;
  startedAt: string;
  completedAt: string;
  status: "success" | "failed";
  errorMessage?: string | null;
}) {
  const response = await client.post("/tally/agent/sync-state", {
    company_name: input.companyName || null,
    company_guid: input.companyGuid || null,
    sync_mode: input.syncMode,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    status: input.status,
    error_message: input.errorMessage || null,
  });

  return response.data;
}

export async function markHistoricalSyncProgressInCrm(input: {
  companyName: string;
  companyGuid?: string | null;
  fromDate: string;
  toDate: string;
  status: "started" | "success" | "failed";
  errorMessage?: string | null;
}) {
  const response = await client.post("/tally/agent/historical-sync-progress", {
    company_name: input.companyName,
    company_guid: input.companyGuid || null,
    from_date: input.fromDate,
    to_date: input.toDate,
    status: input.status,
    error_message: input.errorMessage || null,
  });

  return response.data;
}
