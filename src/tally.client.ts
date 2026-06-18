import axios from "axios";

const TALLY_URL = process.env.TALLY_URL;
const TALLY_REQUEST_TIMEOUT_MS = Number(
  process.env.TALLY_REQUEST_TIMEOUT_MS || 300000,
);

if (!TALLY_URL) {
  throw new Error("[TALLY CLIENT] TALLY_URL is missing in .env");
}

export type TallyDateRange = {
  fromDate: string; // YYYYMMDD
  toDate: string; // YYYYMMDD
};

export async function postToTally(xml: string) {
  const response = await axios.post(TALLY_URL, xml, {
    headers: {
      "Content-Type": "text/xml",
    },
    timeout: TALLY_REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    responseType: "text",
    transformResponse: [(data) => data],
  });

  return sanitizeTallyXmlResponse(response.data);
}

function escapeXml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeTallyXmlResponse(value: any) {
  return (
    String(value ?? "")
      /**
       * Tally sometimes returns invalid XML control chars as numeric refs like &#4;
       * and sometimes as literal control chars. Both break browser/XML parsing.
       * Regex-based parser works after cleanup.
       */
      .replace(
        /&#(?:x0*(?:[0-8bcef]|1[0-9a-f])|0*(?:[0-8]|1[0-9]|2[0-9]|3[01]));/gi,
        "",
      )
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
  );
}

function buildStaticVariables(companyName?: string | null, extra?: string) {
  return `
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${
          companyName
            ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
            : ""
        }
        ${extra || ""}
      </STATICVARIABLES>
`;
}

function formatTallyDisplayDate(value: string) {
  const raw = String(value || "").replace(/[^0-9]/g, "");

  if (!/^\d{8}$/.test(raw)) return value;

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const year = raw.slice(0, 4);
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));

  return `${day}-${monthNames[month - 1]}-${year}`;
}

function buildDateRangeVariables(dateRange?: TallyDateRange) {
  if (!dateRange?.fromDate || !dateRange?.toDate) {
    return "";
  }

  const fromDateDisplay = escapeXml(formatTallyDisplayDate(dateRange.fromDate));
  const toDateDisplay = escapeXml(formatTallyDisplayDate(dateRange.toDate));

  return `
        <SVFromDate TYPE="Date">${fromDateDisplay}</SVFromDate>
        <SVToDate TYPE="Date">${toDateDisplay}</SVToDate>
        <SVCurrentDate TYPE="Date">${toDateDisplay}</SVCurrentDate>

        <SVFROMDATE TYPE="Date">${fromDateDisplay}</SVFROMDATE>
        <SVTODATE TYPE="Date">${toDateDisplay}</SVTODATE>
        <SVCURRENTDATE TYPE="Date">${toDateDisplay}</SVCURRENTDATE>
`;
}

function buildDateRangeFilterFormula(dateRange?: TallyDateRange) {
  if (!dateRange?.fromDate || !dateRange?.toDate) {
    return `
          <SYSTEM TYPE="Formulae" NAME="DateInSelectedRange">
            Yes
          </SYSTEM>
`;
  }

  return `
          <SYSTEM TYPE="Formulae" NAME="DateInSelectedRange">
            NOT $$IsEmpty:$Date
            AND $Date &gt;= ##SVFromDate
            AND $Date &lt;= ##SVToDate
          </SYSTEM>
`;
}

export async function fetchLedgersXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Ledgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Ledgers" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <FETCH>Name,Guid,MasterId,AlterId,Parent,Email,LedgerPhone,GSTRegistrationNumber,Address</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchStockItemsXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Stock Items</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Stock Items" ISMODIFY="No">
            <TYPE>Stock Item</TYPE>
            <FETCH>Name,Guid,MasterId,AlterId,Parent,BaseUnits,OpeningBalance,OpeningRate,OpeningValue,GSTHSNCode</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchOutstandingsXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Outstanding Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Outstanding Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyAccountingVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyAccountingVouchers">
            NOT $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchSalesOrdersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Sales Register</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Sales Register" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicBuyerName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              LedgerEntries,
              AllLedgerEntries,
              InventoryEntries,
              AllInventoryEntries
            </FETCH>
            <FILTER>OnlySalesVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

         <SYSTEM TYPE="Formulae" NAME="OnlySalesVouchers">
  $VoucherTypeName = "Sales"
</SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchPurchaseOrdersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Purchase Register</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Purchase Register" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicSupplierName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              LedgerEntries,
              AllLedgerEntries,
              InventoryEntries,
              AllInventoryEntries
            </FETCH>
            <FILTER>OnlyPurchaseVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyPurchaseVouchers">
            $$IsPurchase:$VoucherTypeName OR $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

/**
 * Deep historical transaction pull.
 * These functions are intentionally separate from existing historical sync.
 * Existing fetchSalesOrdersXml/fetchPurchaseOrdersXml remain unchanged.
 */
export async function fetchHistoricalSalesVouchersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Sales Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Sales Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicBuyerName,
              BasicOrderRef,
              BasicBuyerOrderNo,
              BasicDueDateOfPymt,
              LedgerEntries,
              AllLedgerEntries,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyDeepSalesVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyDeepSalesVouchers">
            $$IsSales:$VoucherTypeName AND NOT $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchHistoricalPurchaseVouchersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Purchase Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Purchase Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              BasicSupplierName,
              BasicOrderRef,
              BasicDueDateOfPymt,
              LedgerEntries,
              AllLedgerEntries,
              InventoryEntries,
              AllInventoryEntries,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
             <FILTER>OnlyDeepPurchaseVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyDeepPurchaseVouchers">
            $$IsPurchase:$VoucherTypeName AND NOT $$IsOrder:$VoucherTypeName
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchHistoricalOutstandingVouchersXml(
  companyName?: string,
  dateRange?: TallyDateRange,
) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Deep Outstanding Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName, buildDateRangeVariables(dateRange))}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Deep Outstanding Vouchers" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>
              Date,
              Guid,
              VoucherKey,
              MasterId,
              AlterId,
              VoucherNumber,
              VoucherTypeName,
              PartyLedgerName,
              PartyName,
              Reference,
              Narration,
              Amount,
              LedgerEntries,
              AllLedgerEntries,
              BillAllocations,
              CategoryAllocations,
              CostCentreAllocations
            </FETCH>
            <FILTER>OnlyOutstandingAffectingVouchers</FILTER>
            <FILTER>DateInSelectedRange</FILTER>
          </COLLECTION>

          <SYSTEM TYPE="Formulae" NAME="OnlyOutstandingAffectingVouchers">
            $$IsSales:$VoucherTypeName
            OR $$IsPurchase:$VoucherTypeName
            OR $VoucherTypeName = "Receipt"
            OR $VoucherTypeName = "Payment"
          </SYSTEM>
          ${buildDateRangeFilterFormula(dateRange)}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchCostCentersXml(companyName?: string) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Cost Centers</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${buildStaticVariables(companyName)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Cost Centers" ISMODIFY="No">
            <TYPE>Cost Centre</TYPE>
            <FETCH>Name,GUID,Parent,Category,Description</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

  return postToTally(xml);
}

export async function fetchTallyCompaniesXml() {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRM Loaded Companies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRM Loaded Companies" ISMODIFY="No">
            <TYPE>Company</TYPE>
            <FETCH>Name,Guid,StartingFrom,BooksFrom,CountryOfResidence,StateName</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  return postToTally(xml);
}
