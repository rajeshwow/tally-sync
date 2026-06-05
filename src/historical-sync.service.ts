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

let isHistoricalSyncRunning = false;

type TallyCompanyForSync = {
  name: string;
  guid?: string | null;
  state?: string | null;
  country?: string | null;
  booksFrom?: string | null;
  startingFrom?: string | null;
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

function buildFinancialYearRanges(input: {
  startYear: number;
  endDate?: Date;
}): TallyDateRange[] {
  const today = input.endDate || new Date();
  const ranges: TallyDateRange[] = [];

  const currentFinancialYear =
    today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;

  for (let year = input.startYear; year <= currentFinancialYear; year++) {
    const from = new Date(year, 3, 1);
    const to = new Date(year + 1, 2, 31);

    ranges.push({
      fromDate: formatTallyDate(from),
      toDate: formatTallyDate(to > today ? today : to),
    });
  }

  return ranges;
}

async function syncCompanyMasters(company: TallyCompanyForSync) {
  console.log("[HISTORICAL SYNC] Masters started", {
    company: company.name,
  });

  await updateTallyConnectionInCrm({
    companyName: company.name,
    companyGuid: company.guid,
  });

  const ledgersXml = await fetchLedgersXml(company.name);
  const ledgers = attachCompany(
    parseLedgers(String(ledgersXml || "")),
    company,
  );

  const ledgerResult = await pushLedgersToCrm(ledgers, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: 500,
  });

  const stockItemsXml = await fetchStockItemsXml(company.name);
  const stockItems = attachCompany(
    parseStockItems(String(stockItemsXml || "")),
    company,
  );

  const stockItemResult = await pushStockItemsToCrm(stockItems, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: 500,
  });

  const costCentersXml = await fetchCostCentersXml(company.name);
  const costCenters = attachCompany(
    parseCostCenters(String(costCentersXml || "")),
    company,
  );

  const costCenterResult = await pushCostCentersToCrm(costCenters, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: 500,
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
    const salesOrdersXml = await fetchSalesOrdersXml(company.name, dateRange);
    const salesOrders = attachCompany(
      parseSalesOrders(String(salesOrdersXml || "")),
      company,
    );

    const salesOrderResult = await pushSalesOrdersToCrm(salesOrders, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "historical",
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: 100,
    });

    const purchaseOrdersXml = await fetchPurchaseOrdersXml(
      company.name,
      dateRange,
    );

    const purchaseOrders = attachCompany(
      parsePurchaseOrders(String(purchaseOrdersXml || "")),
      company,
    );

    const purchaseOrderResult = await pushPurchaseOrdersToCrm(purchaseOrders, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "historical",
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: 100,
    });

    const outstandingsXml = await fetchOutstandingsXml(company.name, dateRange);
    const parsedOutstandings = parseOutstandings(String(outstandingsXml || ""));

    const outstandings = attachCompany(
      enrichOutstandingsWithLedgerGuid(parsedOutstandings, ledgers),
      company,
    );

    const outstandingResult = await pushOutstandingsToCrm(outstandings, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "historical",
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: 100,
    });

    await markHistoricalSyncProgressInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "success",
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

    throw error;
  }
}

export async function runHistoricalSync(input?: {
  startYear?: number;
  companyName?: string;
}) {
  if (isHistoricalSyncRunning) {
    return {
      skipped: true,
      message: "Previous historical sync is still running",
    };
  }

  isHistoricalSyncRunning = true;

  const startedAt = new Date().toISOString();

  try {
    const startYear = input?.startYear || 2022;

    console.log("[HISTORICAL SYNC] Started", {
      startYear,
      companyName: input?.companyName || "ALL",
    });

    const companies = await getCompaniesForHistoricalSync();

    const selectedCompanies = input?.companyName
      ? companies.filter(
          (company) =>
            normalizeName(company.name) === normalizeName(input.companyName),
        )
      : companies;

    if (!selectedCompanies.length) {
      return {
        skipped: false,
        status: "empty",
        message: "No company found",
      };
    }

    const dateRanges = buildFinancialYearRanges({
      startYear,
    });

    const companyResults = [];

    for (const company of selectedCompanies) {
      const companyStartedAt = new Date().toISOString();

      console.log("[HISTORICAL SYNC] Company started", {
        company: company.name,
        guid: company.guid,
      });

      try {
        const masterResult = await syncCompanyMasters(company);

        const rangeResults = [];

        for (const dateRange of dateRanges) {
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
          masters: masterResult.counts,
          ranges: rangeResults,
        });

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

    return {
      skipped: false,
      status: "success",
      message: "Historical sync completed",
      startedAt,
      completedAt,
      companies: {
        count: selectedCompanies.length,
        records: selectedCompanies,
      },
      ranges: dateRanges,
      companyResults,
    };
  } finally {
    isHistoricalSyncRunning = false;
  }
}
