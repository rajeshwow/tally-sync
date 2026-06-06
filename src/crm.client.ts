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

type PushOptions = {
  batchSize?: number;
  companyName?: string;
  companyGuid?: string | null;
  moduleName?: string;
  syncMode?: SyncMode;
  fromDate?: string | null;
  toDate?: string | null;
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
      await sleep(1000 * attempt);
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
  const batchSize = options.batchSize || 200;
  const batches = chunkArray(safeRecords, batchSize);

  const summary = {
    moduleName: options.moduleName || url,
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
    results: [] as any[],
  };

  if (!safeRecords.length) {
    console.log("[CRM CLIENT] No records to push", summary);
    return summary;
  }

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];

    console.log("[CRM CLIENT] Pushing batch", {
      moduleName: summary.moduleName,
      companyName: summary.companyName,
      syncMode: summary.syncMode,
      fromDate: summary.fromDate,
      toDate: summary.toDate,
      batch: `${index + 1}/${batches.length}`,
      records: batch.length,
    });

    try {
      const result = await postWithRetry(url, {
        records: batch,
        meta: {
          company_name: options.companyName || null,
          company_guid: options.companyGuid || null,
          module_name: options.moduleName || null,
          sync_mode: options.syncMode || "incremental",
          from_date: options.fromDate || null,
          to_date: options.toDate || null,
          batch_no: index + 1,
          total_batches: batches.length,
          batch_size: batch.length,
        },
      });

      summary.successBatches += 1;
      summary.results.push(result);

      const importedBatches = index + 1;
      const pendingBatches = batches.length - importedBatches;
      const importedRecords = Math.min(importedBatches * batchSize, safeRecords.length);
      const pendingRecords = Math.max(safeRecords.length - importedRecords, 0);

      console.log("[CRM CLIENT] Batch imported", {
        moduleName: summary.moduleName,
        companyName: summary.companyName,
        syncMode: summary.syncMode,
        fromDate: summary.fromDate,
        toDate: summary.toDate,
        packetsImported: `${importedBatches}/${batches.length}`,
        packetsPending: pendingBatches,
        recordsImported: importedRecords,
        recordsPending: pendingRecords,
        lastPacketSize: batch.length,
      });
    } catch (error) {
      summary.failedBatches += 1;
      throw error;
    }
  }

  return summary;
}

export async function pushLedgersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/ledgers", records, {
    ...options,
    batchSize: options.batchSize || 500,
    moduleName: "ledgers",
  });
}

export async function pushStockItemsToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/stock-items", records, {
    ...options,
    batchSize: options.batchSize || 500,
    moduleName: "stock-items",
  });
}

export async function pushOutstandingsToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/outstandings", records, {
    ...options,
    batchSize: options.batchSize || 100,
    moduleName: "outstandings",
  });
}

export async function pushSalesOrdersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/sales-orders", records, {
    ...options,
    batchSize: options.batchSize || 100,
    moduleName: "sales-orders",
  });
}

export async function pushPurchaseOrdersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/purchase-orders", records, {
    ...options,
    batchSize: options.batchSize || 100,
    moduleName: "purchase-orders",
  });
}

export async function pushCostCentersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/cost-centers", records, {
    ...options,
    batchSize: options.batchSize || 500,
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
