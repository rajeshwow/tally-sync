import {
  getTallySyncStateFromCrm,
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

let isSyncRunning = false;

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

async function getCompaniesForSync(): Promise<TallyCompanyForSync[]> {
  try {
    const companiesXml = await fetchTallyCompaniesXml();
    const companies = parseTallyCompanies(String(companiesXml || ""));

    if (companies.length) {
      console.log("[TALLY] Loaded companies found:", companies);
      return companies;
    }

    console.warn("[TALLY] No companies found from Tally XML response");
  } catch (error: any) {
    console.error("[TALLY] Failed to fetch company list:", {
      message: error?.message,
    });
  }

  const envCompanies = parseEnvCompanies();

  if (envCompanies.length) {
    console.log("[TALLY] Using TALLY_COMPANIES fallback:", envCompanies);
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

function getTodayStartDate() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildIncrementalDateRange(lastSuccessfulSyncAt?: string | null) {
  const today = new Date();

  const fromDate = lastSuccessfulSyncAt
    ? new Date(lastSuccessfulSyncAt)
    : getTodayStartDate();

  return {
    fromDate: formatTallyDate(fromDate),
    toDate: formatTallyDate(today),
  };
}

async function getDateRangeForCompany(
  company: TallyCompanyForSync,
): Promise<TallyDateRange> {
  try {
    const stateRes = await getTallySyncStateFromCrm({
      companyName: company.name,
      companyGuid: company.guid,
    });

    const state = stateRes?.data || stateRes;

    return buildIncrementalDateRange(state?.last_successful_sync_at || null);
  } catch (error: any) {
    console.warn("[TALLY] Failed to get sync state, using today only", {
      company: company.name,
      message: error?.message,
    });

    return buildIncrementalDateRange(null);
  }
}

async function syncOneCompany(company: TallyCompanyForSync) {
  const startedAt = new Date().toISOString();

  console.log(`[TALLY] Incremental company sync started: ${company.name}`);

  await updateTallyConnectionInCrm({
    companyName: company.name,
    companyGuid: company.guid,
  });

  const dateRange = await getDateRangeForCompany(company);

  console.log("[TALLY] Incremental date range", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
  });

  try {
    const ledgersXml = await fetchLedgersXml(company.name);
    const ledgerXmlText = String(ledgersXml || "");

    const ledgers = attachCompany(parseLedgers(ledgerXmlText), company);

    const ledgerResult = await pushLedgersToCrm(ledgers, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      batchSize: 50,
    });

    const costCentersXml = await fetchCostCentersXml(company.name);
    const costCenters = attachCompany(
      parseCostCenters(costCentersXml),
      company,
    );

    const costCenterResult = await pushCostCentersToCrm(costCenters, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      batchSize: 50,
    });

    const stockItemsXml = await fetchStockItemsXml(company.name);
    const stockXmlText = String(stockItemsXml || "");

    const stockItems = attachCompany(parseStockItems(stockXmlText), company);

    const stockItemResult = await pushStockItemsToCrm(stockItems, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      batchSize: 50,
    });

    const salesOrdersXml = await fetchSalesOrdersXml(company.name, dateRange);
    const salesOrdersXmlText = String(salesOrdersXml || "");

    const salesOrders = attachCompany(
      parseSalesOrders(salesOrdersXmlText),
      company,
    );

    const salesOrderResult = await pushSalesOrdersToCrm(salesOrders, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: 50,
    });

    const purchaseOrdersXml = await fetchPurchaseOrdersXml(
      company.name,
      dateRange,
    );
    const purchaseOrdersXmlText = String(purchaseOrdersXml || "");

    const purchaseOrders = attachCompany(
      parsePurchaseOrders(purchaseOrdersXmlText),
      company,
    );

    const purchaseOrderResult = await pushPurchaseOrdersToCrm(purchaseOrders, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: 50,
    });

    const outstandingsXml = await fetchOutstandingsXml(company.name, dateRange);
    const outstandingXmlText = String(outstandingsXml || "");

    const parsedOutstandings = parseOutstandings(outstandingXmlText);

    const outstandings = attachCompany(
      enrichOutstandingsWithLedgerGuid(parsedOutstandings, ledgers),
      company,
    );

    const outstandingResult = await pushOutstandingsToCrm(outstandings, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: 50,
    });

    const completedAt = new Date().toISOString();

    await updateTallySyncStateInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      startedAt,
      completedAt,
      status: "success",
    });

    console.log(`[TALLY] Incremental company sync completed: ${company.name}`);

    return {
      company,
      dateRange,
      ledgers: {
        count: ledgers.length,
        result: ledgerResult,
      },
      stockItems: {
        count: stockItems.length,
        result: stockItemResult,
      },
      outstandings: {
        count: outstandings.length,
        result: outstandingResult,
      },
      salesOrders: {
        count: salesOrders.length,
        result: salesOrderResult,
      },
      purchaseOrders: {
        count: purchaseOrders.length,
        result: purchaseOrderResult,
      },
      costCenters: {
        count: costCenters.length,
        result: costCenterResult,
      },
    };
  } catch (error: any) {
    const completedAt = new Date().toISOString();

    await updateTallySyncStateInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      startedAt,
      completedAt,
      status: "failed",
      errorMessage: error?.message || "Incremental sync failed",
    });

    throw error;
  }
}

export async function runFullSync() {
  if (isSyncRunning) {
    return {
      skipped: true,
      message: "Previous sync is still running",
    };
  }

  isSyncRunning = true;

  try {
    const companies = await getCompaniesForSync();

    if (!companies.length) {
      throw new Error(
        "No Tally companies found. Open/load companies in Tally or add TALLY_COMPANIES in .env",
      );
    }

    const companyResults = [];

    for (const company of companies) {
      const result = await syncOneCompany(company);
      companyResults.push(result);
    }

    const totals = companyResults.reduce(
      (acc, item) => {
        acc.ledgers += item.ledgers.count;
        acc.stockItems += item.stockItems.count;
        acc.outstandings += item.outstandings.count;
        acc.salesOrders += item.salesOrders.count;
        acc.purchaseOrders += item.purchaseOrders.count;
        acc.costCenters += item.costCenters.count;

        return acc;
      },
      {
        ledgers: 0,
        stockItems: 0,
        outstandings: 0,
        salesOrders: 0,
        purchaseOrders: 0,
        costCenters: 0,
      },
    );

    return {
      skipped: false,
      syncMode: "incremental",
      companies: {
        count: companies.length,
        records: companies,
      },
      totals,
      companyResults,
    };
  } finally {
    isSyncRunning = false;
  }
}
