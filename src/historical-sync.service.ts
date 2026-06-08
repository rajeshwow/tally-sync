import {
  markHistoricalSyncProgressInCrm,
  pushCostCentersToCrm,
  pushLedgersToCrm,
  pushOutstandingsToCrm,
  pushPurchaseOrdersToCrm,
  pushSalesOrdersToCrm,
  pushStockItemsToCrm,
  updateTallyConnectionInCrm,
  updateTallySyncStateInCrm,
  type PushProgressEvent,
} from "./crm.client";

import {
  parseCostCenters,
  parseLedgers,
  parseOutstandings,
  parsePurchaseOrders,
  parseSalesOrders,
  parseStockItems,
} from "./mapper";

import {
  fetchCostCentersXml,
  fetchLedgersXml,
  fetchOutstandingsXml,
  fetchPurchaseOrdersXml,
  fetchSalesOrdersXml,
  fetchStockItemsXml,
  fetchTallyCompaniesXml,
  type TallyDateRange,
} from "./tally.client";

import {
  addSyncEvent,
  completeCompany,
  completeRange,
  finishSyncProgress,
  getSyncProgress,
  setActiveCompany,
  setActiveRange,
  startSyncProgress,
  upsertModuleProgress,
} from "./sync-progress.store";

import {
  clearHistoricalSyncCheckpoints,
  getSyncCheckpoint,
  listHistoricalSyncCheckpoints,
  markSyncCheckpoint,
} from "./sync-checkpoint.store";

let isHistoricalSyncRunning = false;

type HistoricalSyncRequest = {
  /**
   * Optional legacy input. Prefer fromDate.
   * If fromDate is missing and startYear exists, fromDate becomes `${startYear}0401`.
   */
  startYear?: number;
  /** Tally date format: YYYYMMDD. Example: 20160401 */
  fromDate?: string;
  /** Tally date format: YYYYMMDD. Defaults to today. */
  toDate?: string;
  companyName?: string;
  /** Clear historical checkpoints and run everything again. */
  forceRestart?: boolean;
};

type NormalizedHistoricalSyncRequest = {
  fromDate: string;
  toDate: string;
  companyName: string;
  forceRestart: boolean;
};

type HistoricalSyncStatus = {
  status: "idle" | "running" | "success" | "failed";
  isRunning: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  request: NormalizedHistoricalSyncRequest | null;
  lastResult: any;
};

const historicalSyncStatus: HistoricalSyncStatus = {
  status: "idle",
  isRunning: false,
  startedAt: null,
  completedAt: null,
  error: null,
  request: null,
  lastResult: null,
};

type TallyCompanyForSync = {
  name: string;
  guid?: string | null;
  state?: string | null;
  country?: string | null;
  booksFrom?: string | null;
  startingFrom?: string | null;
};

type HistoricalCompanyPlan = {
  company: TallyCompanyForSync;
  fromDate: string;
  toDate: string;
  dateRanges: TallyDateRange[];
};

function decodeXml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, `"`)
    .replace(/&apos;/g, "'");
}

function readTag(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );

  return decodeXml(match?.[1]?.trim() || "");
}

function readAttr(block: string, tag: string, attr: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i"));

  return decodeXml(match?.[1]?.trim() || "");
}

function parseTallyCompanies(xml: string): TallyCompanyForSync[] {
  const text = String(xml || "");
  const companyBlocks = text.match(/<COMPANY[\s\S]*?<\/COMPANY>/gi) || [];

  const companies = companyBlocks
    .map((block) => {
      const attrName = readAttr(block, "COMPANY", "NAME");
      const tagName = readTag(block, "NAME");

      return {
        name: attrName || tagName,
        guid: readTag(block, "GUID") || null,
        state: readTag(block, "STATENAME") || null,
        country: readTag(block, "COUNTRYOFRESIDENCE") || null,
        booksFrom: readTag(block, "BOOKSFROM") || null,
        startingFrom: readTag(block, "STARTINGFROM") || null,
      };
    })
    .filter((company) => Boolean(company.name));

  const unique = new Map<string, TallyCompanyForSync>();

  for (const company of companies) {
    const key = company.guid || company.name.toLowerCase().trim();

    if (!unique.has(key)) {
      unique.set(key, company);
    }
  }

  return Array.from(unique.values());
}

function parseEnvCompanies(): TallyCompanyForSync[] {
  return String(process.env.TALLY_COMPANIES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      guid: null,
    }));
}

async function getCompaniesForHistoricalSync(): Promise<TallyCompanyForSync[]> {
  try {
    const companiesXml = await fetchTallyCompaniesXml();
    const companies = parseTallyCompanies(String(companiesXml || ""));

    if (companies.length) {
      console.log("[HISTORICAL SYNC] Loaded companies found:", companies);
      return companies;
    }

    console.warn(
      "[HISTORICAL SYNC] No companies found from Tally XML response",
    );
  } catch (error: any) {
    console.error("[HISTORICAL SYNC] Failed to fetch company list:", {
      message: error?.message,
    });
  }

  const envCompanies = parseEnvCompanies();

  if (envCompanies.length) {
    console.log(
      "[HISTORICAL SYNC] Using TALLY_COMPANIES fallback:",
      envCompanies,
    );
    return envCompanies;
  }

  return [];
}

function normalizeName(value: any) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTallyDate(value?: string | null): string | null {
  const raw = String(value || "").trim();

  if (!raw) return null;

  const compact = raw.replace(/[^0-9]/g, "");

  if (/^\d{8}$/.test(compact)) {
    // Already YYYYMMDD.
    if (Number(compact.slice(0, 4)) > 1900) return compact;

    // DDMMYYYY fallback.
    return `${compact.slice(4, 8)}${compact.slice(2, 4)}${compact.slice(0, 2)}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatTallyDate(parsed);
  }

  return null;
}

function parseTallyDate(value: string): Date {
  const normalized = normalizeTallyDate(value);

  if (!normalized) {
    throw new Error(`Invalid Tally date: ${value}`);
  }

  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6)) - 1;
  const day = Number(normalized.slice(6, 8));

  return new Date(year, month, day);
}

function resolveRequestFromDate(input?: HistoricalSyncRequest) {
  const directFromDate = normalizeTallyDate(input?.fromDate);
  if (directFromDate) return directFromDate;

  const envFromDate =
    normalizeTallyDate(process.env.HISTORICAL_SYNC_FROM_DATE) ||
    normalizeTallyDate(process.env.TALLY_FROM_DATE);

  if (envFromDate) return envFromDate;

  if (input?.startYear) {
    return `${Number(input.startYear)}0401`;
  }

  return "";
}

function resolveRequestToDate(input?: HistoricalSyncRequest) {
  return (
    normalizeTallyDate(input?.toDate) ||
    normalizeTallyDate(process.env.HISTORICAL_SYNC_TO_DATE) ||
    normalizeTallyDate(process.env.TALLY_TO_DATE) ||
    formatTallyDate(new Date())
  );
}

function resolveCompanyHistoricalFromDate(
  company: TallyCompanyForSync,
  request: NormalizedHistoricalSyncRequest,
) {
  return (
    request.fromDate ||
    normalizeTallyDate(company.booksFrom) ||
    normalizeTallyDate(company.startingFrom) ||
    ""
  );
}

function enrichOutstandingsWithLedgerGuid(outstandings: any[], ledgers: any[]) {
  const ledgerByName = new Map<string, any>();

  for (const ledger of ledgers) {
    const key = normalizeName(ledger.name);

    if (key && ledger.guid) {
      ledgerByName.set(key, ledger);
    }
  }

  return outstandings.map((row) => {
    const key = normalizeName(row.ledgerName);
    const matchedLedger = ledgerByName.get(key);

    return {
      ...row,
      ledgerGuid: row.ledgerGuid || matchedLedger?.guid || null,
      ledgerMasterId: row.ledgerMasterId || matchedLedger?.masterId || null,
      ledgerAlterId: row.ledgerAlterId || matchedLedger?.alterId || null,
    };
  });
}

function attachCompany<T extends Record<string, any>>(
  records: T[],
  company: TallyCompanyForSync,
): T[] {
  return records.map((record) => ({
    ...record,

    tallyCompanyName: company.name,
    tallyCompanyGuid: company.guid || null,

    tally_company_name: company.name,
    tally_company_guid: company.guid || null,
  }));
}

function formatTallyDate(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}${mm}${dd}`;
}

function getRangeChunkMonths() {
  return Math.max(1, Number(process.env.HISTORICAL_SYNC_RANGE_MONTHS || 1));
}

function buildHistoricalDateRanges(input: {
  fromDate: string;
  toDate?: string;
}): TallyDateRange[] {
  const fromDate = parseTallyDate(input.fromDate);
  const toDate = parseTallyDate(input.toDate || formatTallyDate(new Date()));

  if (fromDate > toDate) {
    throw new Error(
      `Historical fromDate cannot be greater than toDate: ${input.fromDate} > ${input.toDate}`,
    );
  }

  const ranges: TallyDateRange[] = [];
  const chunkMonths = getRangeChunkMonths();
  let rangeStart = new Date(fromDate);

  while (rangeStart <= toDate) {
    const rangeEnd = new Date(
      rangeStart.getFullYear(),
      rangeStart.getMonth() + chunkMonths,
      0,
    );

    ranges.push({
      fromDate: formatTallyDate(rangeStart),
      toDate: formatTallyDate(rangeEnd > toDate ? toDate : rangeEnd),
    });

    rangeStart = new Date(
      rangeEnd.getFullYear(),
      rangeEnd.getMonth(),
      rangeEnd.getDate() + 1,
    );
  }

  return ranges;
}

function normalizeHistoricalRequest(
  input?: HistoricalSyncRequest,
): NormalizedHistoricalSyncRequest {
  return {
    fromDate: resolveRequestFromDate(input),
    toDate: resolveRequestToDate(input),
    companyName: input?.companyName || "",
    forceRestart: Boolean(input?.forceRestart),
  };
}

function setHistoricalSyncStatus(
  patch: Partial<HistoricalSyncStatus>,
): HistoricalSyncStatus {
  Object.assign(historicalSyncStatus, patch);
  return getHistoricalSyncStatus();
}

function buildHistoricalLiveProgress(progress: any) {
  const modules = Array.isArray(progress.modules) ? progress.modules : [];

  const activeModule =
    modules.find((item: any) =>
      ["fetching", "parsed", "uploading"].includes(item.status),
    ) ||
    modules.find((item: any) => item.status === "failed") ||
    null;

  const activeModuleIndex = activeModule
    ? modules.findIndex((item: any) => item.key === activeModule.key) + 1
    : Math.min(progress.summary.modulesCompleted || 0, modules.length);

  const modulesCompleted = modules.filter((item: any) =>
    ["success", "skipped"].includes(item.status),
  ).length;

  const modulesFailed = modules.filter(
    (item: any) => item.status === "failed",
  ).length;

  return {
    runId: progress.runId,
    mode: progress.mode,
    status: progress.status,
    isRunning: progress.isRunning,

    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    error: progress.error,

    currentCompany: {
      step: `${progress.activeCompany.index || 0}/${progress.activeCompany.total || 0}`,
      index: progress.activeCompany.index || 0,
      total: progress.activeCompany.total || 0,
      name: progress.activeCompany.name || null,
      guid: progress.activeCompany.guid || null,
    },

    currentRange: {
      step: `${progress.activeRange.index || 0}/${progress.activeRange.total || 0}`,
      index: progress.activeRange.index || 0,
      total: progress.activeRange.total || 0,
      fromDate: progress.activeRange.fromDate || null,
      toDate: progress.activeRange.toDate || null,
    },

    currentModule: activeModule
      ? {
          step: `${activeModuleIndex}/${modules.length}`,
          index: activeModuleIndex,
          total: modules.length,
          name: activeModule.moduleName,
          companyName: activeModule.companyName || null,
          companyGuid: activeModule.companyGuid || null,
          fromDate: activeModule.fromDate || null,
          toDate: activeModule.toDate || null,
          status: activeModule.status,

          pulledRecords: activeModule.totalRecords || 0,
          uploadedRecords: activeModule.uploadedRecords || 0,
          pendingRecords: activeModule.pendingRecords || 0,
          failedRecords: activeModule.failedRecords || 0,

          batch: `${activeModule.currentBatch || 0}/${activeModule.totalBatches || 0}`,
          currentBatch: activeModule.currentBatch || 0,
          totalBatches: activeModule.totalBatches || 0,
          uploadedBatches: activeModule.uploadedBatches || 0,
          failedBatches: activeModule.failedBatches || 0,

          startedAt: activeModule.startedAt || null,
          completedAt: activeModule.completedAt || null,
          error: activeModule.error || null,
        }
      : null,

    summary: {
      companies: `${progress.summary.companiesCompleted || 0}/${progress.summary.companiesTotal || 0}`,
      ranges: `${progress.summary.rangesCompleted || 0}/${progress.summary.rangesTotal || 0}`,
      modules: `${modulesCompleted}/${modules.length}`,
      modulesTotal: modules.length,
      modulesCompleted,
      modulesFailed,

      pulledRecords: progress.summary.totalRecords || 0,
      uploadedRecords: progress.summary.uploadedRecords || 0,
      pendingRecords: progress.summary.pendingRecords || 0,
      failedRecords: progress.summary.failedRecords || 0,

      progressPercent: progress.summary.progressPercent || 0,
    },

    recentEvents: Array.isArray(progress.events)
      ? progress.events.slice(0, 15)
      : [],
  };
}

export function getHistoricalSyncStatus(): any {
  const progress = getSyncProgress();
  const checkpoints = listHistoricalSyncCheckpoints();

  return {
    ...historicalSyncStatus,
    live: buildHistoricalLiveProgress(progress),
    progress,
    checkpoints: {
      total: checkpoints.length,
      success: checkpoints.filter((item) => item.status === "success").length,
      failed: checkpoints.filter((item) => item.status === "failed").length,
      running: checkpoints.filter((item) => item.status === "running").length,
      records: checkpoints.slice(-50),
    },
  };
}

function createCrmPushProgressHandler() {
  return (event: PushProgressEvent) => {
    const statusByEvent: Record<PushProgressEvent["type"], any> = {
      module_start: "uploading",
      batch_start: "uploading",
      batch_success: "uploading",
      batch_failed: "failed",
      module_complete: "success",
    };

    upsertModuleProgress({
      moduleName: event.moduleName,
      companyName: event.companyName || null,
      companyGuid: event.companyGuid || null,
      fromDate: event.fromDate || null,
      toDate: event.toDate || null,
      status: statusByEvent[event.type],
      totalRecords: event.totalRecords,
      uploadedRecords: event.uploadedRecords,
      failedRecords: event.failedRecords,
      pendingRecords: event.pendingRecords,
      batchSize: event.batchSize,
      totalBatches: event.totalBatches,
      uploadedBatches: event.uploadedBatches,
      failedBatches: event.failedBatches,
      currentBatch: event.batchNo || 0,
      completedAt:
        event.type === "module_complete" ? new Date().toISOString() : null,
      error: event.errorMessage || null,
    });

    if (event.type === "batch_success") {
      const _co = event.companyName ? ` [${event.companyName}]` : "";
      const _dr =
        event.fromDate && event.toDate
          ? ` (${event.fromDate}→${event.toDate})`
          : "";
      console.log(
        `[HISTORICAL]${_co} ${event.moduleName.padEnd(18)} ✅ Batch ${event.batchNo}/${event.totalBatches}${_dr} — ${event.uploadedRecords}/${event.totalRecords} records`,
      );
      addSyncEvent({
        level: "info",
        message: `${event.moduleName}: batch ${event.batchNo}/${event.totalBatches} uploaded`,
        companyName: event.companyName || null,
        moduleName: event.moduleName,
        fromDate: event.fromDate || null,
        toDate: event.toDate || null,
        details: {
          uploadedRecords: event.uploadedRecords,
          pendingRecords: event.pendingRecords,
        },
      });
    }

    if (event.type === "batch_failed") {
      const _co = event.companyName ? ` [${event.companyName}]` : "";
      const _dr =
        event.fromDate && event.toDate
          ? ` (${event.fromDate}→${event.toDate})`
          : "";
      console.error(
        `[HISTORICAL]${_co} ${event.moduleName.padEnd(18)} ❌ Batch ${event.batchNo}/${event.totalBatches}${_dr} FAILED — ${event.errorMessage || "unknown error"}`,
      );
      addSyncEvent({
        level: "error",
        message: `${event.moduleName}: batch ${event.batchNo}/${event.totalBatches} failed`,
        companyName: event.companyName || null,
        moduleName: event.moduleName,
        fromDate: event.fromDate || null,
        toDate: event.toDate || null,
        details: event.errorMessage || null,
      });
    }
  };
}

const HISTORICAL_MASTER_MODULES = ["ledgers", "stock-items", "cost-centers"];

const HISTORICAL_RANGE_MODULES = [
  "sales-orders",
  "purchase-orders",
  "outstandings",
];

function seedHistoricalProgressModules(input: {
  plans: HistoricalCompanyPlan[];
}) {
  for (const plan of input.plans) {
    for (const moduleName of HISTORICAL_MASTER_MODULES) {
      upsertModuleProgress({
        moduleName,
        companyName: plan.company.name,
        companyGuid: plan.company.guid,
        status: "pending",
      });
    }

    for (const dateRange of plan.dateRanges) {
      for (const moduleName of HISTORICAL_RANGE_MODULES) {
        upsertModuleProgress({
          moduleName,
          companyName: plan.company.name,
          companyGuid: plan.company.guid,
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
          status: "pending",
        });
      }
    }
  }

  const rangesTotal = input.plans.reduce(
    (sum, plan) => sum + plan.dateRanges.length,
    0,
  );

  const modulesTotal = input.plans.reduce(
    (sum, plan) =>
      sum +
      HISTORICAL_MASTER_MODULES.length +
      plan.dateRanges.length * HISTORICAL_RANGE_MODULES.length,
    0,
  );

  addSyncEvent({
    level: "info",
    message: "Historical sync plan prepared",
    details: {
      companies: input.plans.length,
      rangesTotal,
      modulesTotal,
    },
  });
}

function getHistoricalModuleCheckpoint(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  return getSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
  });
}

function shouldSkipHistoricalModule(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords: number;
}) {
  const checkpoint = getHistoricalModuleCheckpoint(input);

  if (checkpoint?.status !== "success") {
    return false;
  }

  const checkpointRecords = Number(checkpoint.totalRecords || 0);

  /**
   * Important safety guard:
   * Older/current buggy runs may have saved success with 0 records.
   * If this run has records, do not trust that stale checkpoint.
   */
  if (input.totalRecords > 0 && checkpointRecords <= 0) {
    addSyncEvent({
      level: "warn",
      message: `${input.moduleName} checkpoint ignored because it had 0 records but current parse found ${input.totalRecords}`,
      companyName: input.company.name,
      moduleName: input.moduleName,
      fromDate: input.fromDate || null,
      toDate: input.toDate || null,
      details: {
        checkpointRecords,
        currentRecords: input.totalRecords,
      },
    });

    return false;
  }

  return true;
}

function markHistoricalModuleSkipped(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords?: number;
}) {
  const totalRecords = input.totalRecords || 0;

  upsertModuleProgress({
    moduleName: input.moduleName,
    companyName: input.company.name,
    companyGuid: input.company.guid,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "skipped",
    totalRecords,
    uploadedRecords: totalRecords,
    pendingRecords: 0,
    failedRecords: 0,
    completedAt: new Date().toISOString(),
  });

  addSyncEvent({
    level: "info",
    message: `${input.moduleName} skipped because checkpoint already exists`,
    companyName: input.company.name,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
  });
}

function markHistoricalModuleRunning(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  markSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
  });
}

function markHistoricalModuleSuccess(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords?: number;
  uploadedRecords?: number;
}) {
  markSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "success",
    totalRecords: input.totalRecords || 0,
    uploadedRecords: input.uploadedRecords ?? input.totalRecords ?? 0,
    failedRecords: 0,
    completedAt: new Date().toISOString(),
    errorMessage: null,
  });
}

function markHistoricalModuleFailed(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords?: number;
  uploadedRecords?: number;
  failedRecords?: number;
  errorMessage?: string | null;
}) {
  markSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "failed",
    totalRecords: input.totalRecords || 0,
    uploadedRecords: input.uploadedRecords || 0,
    failedRecords: input.failedRecords || 0,
    completedAt: new Date().toISOString(),
    errorMessage: input.errorMessage || "Historical module sync failed",
  });
}

async function uploadHistoricalModule(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  records: any[];
  fromDate?: string | null;
  toDate?: string | null;
  batchSize: any;
  push: (records: any[], options: any) => Promise<any>;
}) {
  const { moduleName, company, records, fromDate, toDate } = input;
  const totalRecords = Array.isArray(records) ? records.length : 0;

  if (
    shouldSkipHistoricalModule({
      moduleName,
      company,
      fromDate,
      toDate,
      totalRecords,
    })
  ) {
    markHistoricalModuleSkipped({
      moduleName,
      company,
      fromDate,
      toDate,
      totalRecords,
    });

    return {
      skipped: true,
      moduleName,
      totalRecords,
      uploadedRecords: totalRecords,
    };
  }

  markHistoricalModuleRunning({ moduleName, company, fromDate, toDate });

  try {
    const result = await input.push(records, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "historical",
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      batchSize: input.batchSize,
      onProgress: createCrmPushProgressHandler(),
    });

    if (totalRecords > 0) {
      markHistoricalModuleSuccess({
        moduleName,
        company,
        fromDate,
        toDate,
        totalRecords,
        uploadedRecords: result?.uploadedRecords ?? totalRecords,
      });
    } else {
      addSyncEvent({
        level: "info",
        message: `${moduleName} had 0 parsed records; checkpoint not saved so future historical runs can pick newly available data`,
        companyName: company.name,
        moduleName,
        fromDate: fromDate || null,
        toDate: toDate || null,
      });
    }

    return result;
  } catch (error: any) {
    markHistoricalModuleFailed({
      moduleName,
      company,
      fromDate,
      toDate,
      totalRecords,
      errorMessage: error?.message || "Historical module sync failed",
    });

    throw error;
  }
}

function buildHistoricalCompanyPlans(input: {
  companies: TallyCompanyForSync[];
  request: NormalizedHistoricalSyncRequest;
}): HistoricalCompanyPlan[] {
  return input.companies.map((company) => {
    const fromDate = resolveCompanyHistoricalFromDate(company, input.request);

    if (!fromDate) {
      throw new Error(
        `Historical fromDate missing for company "${company.name}". Send {"fromDate":"YYYYMMDD"} or make sure Tally company has BooksFrom/StartingFrom.`,
      );
    }

    const dateRanges = buildHistoricalDateRanges({
      fromDate,
      toDate: input.request.toDate,
    });

    return {
      company,
      fromDate,
      toDate: input.request.toDate,
      dateRanges,
    };
  });
}

async function syncCompanyMasters(company: TallyCompanyForSync) {
  console.log("[HISTORICAL SYNC] Masters started", {
    company: company.name,
  });

  await updateTallyConnectionInCrm({
    companyName: company.name,
    companyGuid: company.guid,
  });

  upsertModuleProgress({
    moduleName: "ledgers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "fetching",
  });

  const ledgersXml = await fetchLedgersXml(company.name);
  const ledgers = attachCompany(
    parseLedgers(String(ledgersXml || "")),
    company,
  );

  upsertModuleProgress({
    moduleName: "ledgers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "parsed",
    totalRecords: ledgers.length,
    pendingRecords: ledgers.length,
  });

  const ledgerResult = await pushLedgersToCrm(ledgers, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: process.env.BATCH_SIZE_LEDGERS || 10,
    onProgress: createCrmPushProgressHandler(),
  });

  upsertModuleProgress({
    moduleName: "stock-items",
    companyName: company.name,
    companyGuid: company.guid,
    status: "fetching",
  });

  const stockItemsXml = await fetchStockItemsXml(company.name);
  const stockItems = attachCompany(
    parseStockItems(String(stockItemsXml || "")),
    company,
  );

  upsertModuleProgress({
    moduleName: "stock-items",
    companyName: company.name,
    companyGuid: company.guid,
    status: "parsed",
    totalRecords: stockItems.length,
    pendingRecords: stockItems.length,
  });

  const stockItemResult = await pushStockItemsToCrm(stockItems, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: process.env.BATCH_SIZE_STOCK_ITEMS || 10,
    onProgress: createCrmPushProgressHandler(),
  });

  upsertModuleProgress({
    moduleName: "cost-centers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "fetching",
  });

  const costCentersXml = await fetchCostCentersXml(company.name);
  const costCenters = attachCompany(
    parseCostCenters(String(costCentersXml || "")),
    company,
  );

  upsertModuleProgress({
    moduleName: "cost-centers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "parsed",
    totalRecords: costCenters.length,
    pendingRecords: costCenters.length,
  });

  const costCenterResult = await pushCostCentersToCrm(costCenters, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: process.env.BATCH_SIZE_COST_CENTERS || 10,
    onProgress: createCrmPushProgressHandler(),
  });

  console.log("[HISTORICAL SYNC] Masters completed", {
    company: company.name,
    ledgers: ledgers.length,
    stockItems: stockItems.length,
    costCenters: costCenters.length,
  });

  return {
    ledgers,
    results: {
      ledgers: ledgerResult,
      stockItems: stockItemResult,
      costCenters: costCenterResult,
    },
    counts: {
      ledgers: ledgers.length,
      stockItems: stockItems.length,
      costCenters: costCenters.length,
    },
  };
}

async function syncCompanyTransactionsByRange(input: {
  company: TallyCompanyForSync;
  dateRange: TallyDateRange;
  ledgers: any[];
}) {
  const { company, dateRange, ledgers } = input;

  console.log("[HISTORICAL SYNC] Range started", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
  });

  await markHistoricalSyncProgressInCrm({
    companyName: company.name,
    companyGuid: company.guid,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    status: "started",
  });

  try {
    upsertModuleProgress({
      moduleName: "sales-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const salesOrdersXml = await fetchSalesOrdersXml(company.name, dateRange);
    const salesOrders = attachCompany(
      parseSalesOrders(String(salesOrdersXml || "")),
      company,
    );

    upsertModuleProgress({
      moduleName: "sales-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: salesOrders.length,
      pendingRecords: salesOrders.length,
    });

    const salesOrderResult = await uploadHistoricalModule({
      moduleName: "sales-orders",
      company,
      records: salesOrders,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_SALES_ORDERS || 5,
      push: pushSalesOrdersToCrm,
    });

    upsertModuleProgress({
      moduleName: "purchase-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const purchaseOrdersXml = await fetchPurchaseOrdersXml(
      company.name,
      dateRange,
    );

    const purchaseOrders = attachCompany(
      parsePurchaseOrders(String(purchaseOrdersXml || "")),
      company,
    );

    upsertModuleProgress({
      moduleName: "purchase-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: purchaseOrders.length,
      pendingRecords: purchaseOrders.length,
    });

    const purchaseOrderResult = await uploadHistoricalModule({
      moduleName: "purchase-orders",
      company,
      records: purchaseOrders,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_PURCHASE_ORDERS || 5,
      push: pushPurchaseOrdersToCrm,
    });

    upsertModuleProgress({
      moduleName: "outstandings",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const outstandingsXml = await fetchOutstandingsXml(company.name, dateRange);
    const parsedOutstandings = parseOutstandings(String(outstandingsXml || ""));

    const outstandings = attachCompany(
      enrichOutstandingsWithLedgerGuid(parsedOutstandings, ledgers),
      company,
    );

    upsertModuleProgress({
      moduleName: "outstandings",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: outstandings.length,
      pendingRecords: outstandings.length,
    });

    const outstandingResult = await uploadHistoricalModule({
      moduleName: "outstandings",
      company,
      records: outstandings,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_OUTSTANDINGS || 5,
      push: pushOutstandingsToCrm,
    });

    await markHistoricalSyncProgressInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "success",
    });

    completeRange({
      companyName: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
    });

    console.log("[HISTORICAL SYNC] Range completed", {
      company: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      salesOrders: salesOrders.length,
      purchaseOrders: purchaseOrders.length,
      outstandings: outstandings.length,
    });

    return {
      dateRange,
      salesOrders: {
        count: salesOrders.length,
        result: salesOrderResult,
      },
      purchaseOrders: {
        count: purchaseOrders.length,
        result: purchaseOrderResult,
      },
      outstandings: {
        count: outstandings.length,
        result: outstandingResult,
      },
    };
  } catch (error: any) {
    await markHistoricalSyncProgressInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "failed",
      errorMessage: error?.message || "Historical sync failed",
    });

    addSyncEvent({
      level: "error",
      message: `Range failed: ${dateRange.fromDate} to ${dateRange.toDate}`,
      companyName: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      details: error?.message || "Historical sync failed",
    });

    throw error;
  }
}

export async function runHistoricalSync(input?: HistoricalSyncRequest) {
  if (isHistoricalSyncRunning) {
    return {
      skipped: true,
      message: "Previous historical sync is still running",
    };
  }

  isHistoricalSyncRunning = true;

  const startedAt = new Date().toISOString();
  const request = normalizeHistoricalRequest(input);

  setHistoricalSyncStatus({
    status: "running",
    isRunning: true,
    startedAt,
    completedAt: null,
    error: null,
    request,
    lastResult: null,
  });

  try {
    console.log("[HISTORICAL SYNC] Started", {
      fromDate: request.fromDate || "TALLY_COMPANY_BOOKS_FROM",
      toDate: request.toDate,
      companyName: request.companyName || "ALL",
      forceRestart: request.forceRestart,
    });

    const companies = await getCompaniesForHistoricalSync();

    const selectedCompanies = request.companyName
      ? companies.filter(
          (company) =>
            normalizeName(company.name) === normalizeName(request.companyName),
        )
      : companies;

    if (!selectedCompanies.length) {
      const completedAt = new Date().toISOString();
      const result = {
        skipped: false,
        status: "empty",
        message: "No company found",
      };

      setHistoricalSyncStatus({
        status: "success",
        isRunning: false,
        completedAt,
        error: null,
        lastResult: result,
      });

      return result;
    }

    if (request.forceRestart) {
      for (const company of selectedCompanies) {
        clearHistoricalSyncCheckpoints({
          companyName: company.name,
          companyGuid: company.guid,
        });
      }

      addSyncEvent({
        level: "warn",
        message:
          "Historical sync checkpoints cleared because forceRestart=true",
        details: { companyName: request.companyName || "ALL" },
      });
    }

    const companyPlans = buildHistoricalCompanyPlans({
      companies: selectedCompanies,
      request,
    });

    const rangesTotal = companyPlans.reduce(
      (sum, plan) => sum + plan.dateRanges.length,
      0,
    );

    startSyncProgress({
      mode: "historical",
      request,
      companiesTotal: selectedCompanies.length,
      rangesTotal,
    });

    seedHistoricalProgressModules({
      plans: companyPlans,
    });

    const companyResults = [];

    for (const [companyIndex, plan] of companyPlans.entries()) {
      const { company, dateRanges } = plan;

      setActiveCompany({
        index: companyIndex + 1,
        total: companyPlans.length,
        name: company.name,
        guid: company.guid,
      });

      const companyStartedAt = new Date().toISOString();

      console.log("[HISTORICAL SYNC] Company started", {
        company: company.name,
        guid: company.guid,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
        ranges: dateRanges.length,
      });

      try {
        const masterResult = await syncCompanyMasters(company);

        const rangeResults = [];

        for (const [rangeIndex, dateRange] of dateRanges.entries()) {
          setActiveRange({
            index: rangeIndex + 1,
            total: dateRanges.length,
            fromDate: dateRange.fromDate,
            toDate: dateRange.toDate,
            companyName: company.name,
          });

          const result = await syncCompanyTransactionsByRange({
            company,
            dateRange,
            ledgers: masterResult.ledgers,
          });

          rangeResults.push(result);
        }

        const companyCompletedAt = new Date().toISOString();

        await updateTallySyncStateInCrm({
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "historical",
          startedAt: companyStartedAt,
          completedAt: companyCompletedAt,
          status: "success",
        });

        companyResults.push({
          company,
          fromDate: plan.fromDate,
          toDate: plan.toDate,
          masters: masterResult.counts,
          ranges: rangeResults,
        });

        completeCompany(company.name);

        console.log("[HISTORICAL SYNC] Company completed", {
          company: company.name,
          guid: company.guid,
        });
      } catch (error: any) {
        const companyCompletedAt = new Date().toISOString();

        await updateTallySyncStateInCrm({
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "historical",
          startedAt: companyStartedAt,
          completedAt: companyCompletedAt,
          status: "failed",
          errorMessage: error?.message || "Historical company sync failed",
        });

        throw error;
      }
    }

    const completedAt = new Date().toISOString();

    const result = {
      skipped: false,
      status: "success",
      message: "Historical sync completed",
      startedAt,
      completedAt,
      companies: {
        count: selectedCompanies.length,
        records: selectedCompanies,
      },
      plans: companyPlans.map((plan) => ({
        companyName: plan.company.name,
        companyGuid: plan.company.guid || null,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
        ranges: plan.dateRanges.length,
      })),
      companyResults,
    };

    setHistoricalSyncStatus({
      status: "success",
      isRunning: false,
      completedAt,
      error: null,
      lastResult: result,
    });

    finishSyncProgress({
      status: "success",
      lastResult: result,
    });

    return result;
  } catch (error: any) {
    const completedAt = new Date().toISOString();

    setHistoricalSyncStatus({
      status: "failed",
      isRunning: false,
      completedAt,
      error: error?.message || "Historical sync failed",
      lastResult: null,
    });

    finishSyncProgress({
      status: "failed",
      error: error?.message || "Historical sync failed",
    });

    throw error;
  } finally {
    isHistoricalSyncRunning = false;
  }
}

export function startHistoricalSyncInBackground(input?: HistoricalSyncRequest) {
  if (isHistoricalSyncRunning) {
    return {
      started: false,
      message: "Previous historical sync is still running",
      data: getHistoricalSyncStatus(),
    };
  }

  const request = normalizeHistoricalRequest(input);

  void runHistoricalSync(request).catch((error: any) => {
    console.error("[HISTORICAL SYNC] Background run failed", error);
  });

  return {
    started: true,
    message: "Historical sync started",
    data: {
      ...getHistoricalSyncStatus(),
      request,
    },
  };
}
