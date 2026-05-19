import axios from "axios";

const CRM_BASE_URL = process.env.CRM_BASE_URL || "http://localhost:4000";
const CRM_TENANT_SLUG = process.env.CRM_TENANT_SLUG || "";
const TALLY_AGENT_TOKEN = process.env.TALLY_AGENT_TOKEN || "";

const client = axios.create({
  baseURL: `${CRM_BASE_URL}/${CRM_TENANT_SLUG}`,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${TALLY_AGENT_TOKEN}`,
  },
});

export async function pushLedgersToCrm(records: any[]) {
  const response = await client.post("/tally/pull/ledgers", {
    records,
  });

  return response.data;
}

export async function pushStockItemsToCrm(records: any[]) {
  const response = await client.post("/tally/pull/stock-items", {
    records,
  });

  return response.data;
}

export async function pushOutstandingsToCrm(records: any[]) {
  const response = await client.post("/tally/pull/outstandings", {
    records,
  });

  return response.data;
}

export async function pushSalesOrdersToCrm(records: any[]) {
  const response = await client.post("/tally/pull/sales-orders", {
    records,
  });

  return response.data;
}

export async function pushPurchaseOrdersToCrm(records: any[]) {
  const response = await client.post("/tally/pull/purchase-orders", {
    records,
  });

  return response.data;
}

export async function pushCostCentersToCrm(records: any[]) {
  const response = await client.post("/tally/pull/cost-centers", {
    records,
  });

  return response.data;
}
