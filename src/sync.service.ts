import {
  pushLedgersToCrm,
  pushOutstandingsToCrm,
  pushPurchaseOrdersToCrm,
  pushSalesOrdersToCrm,
  pushStockItemsToCrm,
} from "./crm.client";
import {
  parseLedgers,
  parseOutstandings,
  parsePurchaseOrders,
  parseSalesOrders,
  parseStockItems,
} from "./mapper";
import {
  fetchLedgersXml,
  fetchOutstandingsXml,
  fetchPurchaseOrdersXml,
  fetchSalesOrdersXml,
  fetchStockItemsXml,
} from "./tally.client";

let isSyncRunning = false;

function summarizeStockItems(records: any[]) {
  return records.slice(0, 5).map((item) => ({
    name: item.name,
    parent: item.parent,
    masterId: item.masterId,
    alterId: item.alterId,
    guid: item.guid,

    partNumber: item.partNumber,
    baseUnit: item.baseUnit,
    hsnCode: item.hsnCode,
    gstRate: item.gstRate,

    openingBalance: item.openingBalance,
    openingQty: item.openingQty,
    openingRate: item.openingRate,
    openingValue: item.openingValue,
    openingValueNumber: item.openingValueNumber,

    closingBalance: item.closingBalance,
    closingQty: item.closingQty,
    closingValue: item.closingValue,
    closingValueNumber: item.closingValueNumber,

    baseQty: item.baseQty,
    actualQty: item.actualQty,
    billedQty: item.billedQty,

    price: item.price,
    stockOnHand: item.stockOnHand,
    availableForSale: item.availableForSale,
  }));
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

export async function runFullSync() {
  if (isSyncRunning) {
    return {
      skipped: true,
      message: "Previous sync is still running",
    };
  }

  isSyncRunning = true;

  try {
    const ledgersXml = await fetchLedgersXml();
    const ledgerXmlText = String(ledgersXml || "");

    const ledgers = parseLedgers(ledgerXmlText);

    const ledgerResult = await pushLedgersToCrm(ledgers);

    const stockItemsXml = await fetchStockItemsXml();
    const stockXmlText = String(stockItemsXml || "");

    const stockItems = parseStockItems(stockXmlText);

    const stockItemResult = await pushStockItemsToCrm(stockItems);

    const salesOrdersXml = await fetchSalesOrdersXml();
    const salesOrdersXmlText = String(salesOrdersXml || "");

    const salesOrders = parseSalesOrders(salesOrdersXmlText);

    console.log("[PARSED SALES ORDERS COUNT]", salesOrders.length);
    console.log("[PARSED SALES ORDERS SAMPLE]", salesOrders.slice(0, 3));

    const salesOrderResult = await pushSalesOrdersToCrm(salesOrders);

    const purchaseOrdersXml = await fetchPurchaseOrdersXml();
    const purchaseOrdersXmlText = String(purchaseOrdersXml || "");

    const purchaseOrders = parsePurchaseOrders(purchaseOrdersXmlText);

    const purchaseOrderResult = await pushPurchaseOrdersToCrm(purchaseOrders);

    const outstandingsXml = await fetchOutstandingsXml();
    const outstandingXmlText = String(outstandingsXml || "");

    const parsedOutstandings = parseOutstandings(outstandingXmlText);

    const outstandings = enrichOutstandingsWithLedgerGuid(
      parsedOutstandings,
      ledgers,
    );

    const missingLedgerGuid = outstandings.filter((x) => !x.ledgerGuid);

    const outstandingResult = await pushOutstandingsToCrm(outstandings);

    return {
      skipped: false,
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
    };
  } finally {
    isSyncRunning = false;
  }
}
