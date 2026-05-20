import axios from "axios";

const CRM_BASE_URL = process.env.CRM_BASE_URL || "http://localhost:4000/v1";
const CRM_TENANT_SLUG = process.env.CRM_TENANT_SLUG || "";
const TALLY_AGENT_TOKEN = process.env.TALLY_AGENT_TOKEN || "";

if (!CRM_TENANT_SLUG) {
  console.warn("[CRM CLIENT] CRM_TENANT_SLUG is missing");
}

if (!TALLY_AGENT_TOKEN) {
  console.warn("[CRM CLIENT] TALLY_AGENT_TOKEN is missing");
}

const client = axios.create({
  baseURL: `${CRM_BASE_URL.replace(/\/$/, "")}/${CRM_TENANT_SLUG}`,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${TALLY_AGENT_TOKEN}`,
    "Content-Type": "application/json",
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

export async function pushEmployeesToCrm(records: any[]) {
  const response = await client.post("/tally/pull/employees", {
    records,
  });

  return response.data;
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
    tally_url:
      input.tallyUrl || process.env.TALLY_URL || "http://localhost:9000",
  });

  return response.data;
}
