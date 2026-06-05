function readTag(block: string, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = block.match(
    new RegExp(`<${escapedTag}(\\s[^>]*)?>([\\s\\S]*?)</${escapedTag}>`, "i"),
  );

  return match?.[2]?.trim() || "";
}

function readAttr(block: string, tag: string, attr: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = block.match(
    new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttr}="([^"]*)"`, "i"),
  );

  return match?.[1]?.trim() || "";
}

function stripXml(value: string) {
  return String(value || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x?[0-9a-fA-F]+;/g, "") // removes all numeric XML entities like &#4;, &#x04;
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // removes control chars
    .replace(/<[^>]+>/g, "")
    .replace(/Not Applicable/gi, "")
    .replace(/Not Found/gi, "")
    .replace(/As per Company\/Stock Group/gi, "")
    .replace(/Not Available/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readName(block: string, tag: string) {
  return stripXml(readAttr(block, tag, "NAME") || readTag(block, "NAME"));
}

function toNumber(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? num : 0;
}

function parseCostCenterAllocations(block: string) {
  const allocations: Array<{
    cost_center_name: string;
    cost_category?: string | null;
    amount: number;
  }> = [];

  const categoryBlocks =
    block.match(
      /<CATEGORYALLOCATIONS\.LIST[\s\S]*?<\/CATEGORYALLOCATIONS\.LIST>/gi,
    ) || [];

  for (const categoryBlock of categoryBlocks) {
    const category = stripXml(readTag(categoryBlock, "CATEGORY")) || null;

    const ccBlocks =
      categoryBlock.match(
        /<COSTCENTREALLOCATIONS\.LIST[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/gi,
      ) || [];

    for (const ccBlock of ccBlocks) {
      const name = stripXml(readTag(ccBlock, "NAME"));

      if (!name) continue;

      allocations.push({
        cost_center_name: name,
        cost_category: category,
        amount: Math.abs(toNumber(readTag(ccBlock, "AMOUNT"))),
      });
    }
  }

  return allocations;
}

function getPrimaryCostCenter(block: string) {
  const allocations = parseCostCenterAllocations(block);

  if (!allocations.length) {
    return {
      cost_center_name: null,
      cost_category: null,
      cost_center_amount: 0,
      cost_center_allocations: [],
    };
  }

  const primary = allocations.find((item) => item.amount > 0) || allocations[0];

  return {
    cost_center_name: primary.cost_center_name,
    cost_category: primary.cost_category || null,
    cost_center_amount: primary.amount || 0,
    cost_center_allocations: allocations,
  };
}

function toPositiveNumber(value: any) {
  return Math.abs(toNumber(value));
}

function parseQty(value: any) {
  const cleaned = stripXml(String(value || "")).replace(/,/g, "");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? Math.abs(Number(match[0])) : 0;
}

function readFirstAvailableTag(block: string, tags: string[]) {
  for (const tag of tags) {
    const value = stripXml(readTag(block, tag));
    if (value) return value;
  }

  return "";
}

function extractCrmSalesOrderRef(value?: string | null) {
  const text = stripXml(String(value || "")).trim();

  if (!text) return "";

  const directSoMatch = text.match(/\bSO-\d+\b/i);
  if (directSoMatch?.[0]) {
    return directSoMatch[0].toUpperCase();
  }

  return text
    .replace(/^crm\s*so\s*no\s*[:#-]?\s*/i, "")
    .replace(/^sales\s*order\s*[:#-]?\s*/i, "")
    .trim();
}

function readVoucherReferenceNumber(block: string) {
  const directReference = readFirstAvailableTag(block, [
    "REFERENCE",
    "BASICORDERREF",
    "BASICBUYERORDERNO",
    "ORDERREFERENCE",
    "ORDERREF",
  ]);

  if (directReference) {
    return extractCrmSalesOrderRef(directReference);
  }

  const narration = stripXml(readTag(block, "NARRATION"));

  return extractCrmSalesOrderRef(narration);
}

function readFirstAvailableNumber(block: string, tags: string[]) {
  for (const tag of tags) {
    const value = stripXml(readTag(block, tag));
    const num = toPositiveNumber(value);
    if (num > 0) return num;
  }

  return 0;
}

function readHsnCode(block: string) {
  const directHsn = readFirstAvailableTag(block, [
    "GSTHSNCODE",
    "HSNCODE",
    "HSN",
    "HSNCODEVALUE",
    "HSNSACCODE",
  ]);

  if (directHsn) return directHsn;

  const hsnDetailsBlocks =
    block.match(/<HSNDETAILS\.LIST\b[\s\S]*?<\/HSNDETAILS\.LIST>/gi) || [];

  for (const hsnBlock of hsnDetailsBlocks) {
    const hsn = readFirstAvailableTag(hsnBlock, [
      "HSNCODE",
      "HSN",
      "GSTHSNCODE",
      "HSNSACCODE",
    ]);

    if (hsn) return hsn;
  }

  return "NA";
}

function readGstRate(block: string) {
  const rates = [...block.matchAll(/<GSTRATE>([\s\S]*?)<\/GSTRATE>/gi)]
    .map((m) => toPositiveNumber(m[1]))
    .filter((n) => n > 0);

  if (rates.length) {
    return rates.reduce((sum, n) => sum + n, 0);
  }

  const dutyRateBlocks =
    block.match(/<RATEDETAILS\.LIST\b[\s\S]*?<\/RATEDETAILS\.LIST>/gi) || [];

  const dutyRates = dutyRateBlocks
    .map((rateBlock) =>
      readFirstAvailableNumber(rateBlock, [
        "GSTRATE",
        "RATE",
        "TAXRATE",
        "DUTYRATE",
      ]),
    )
    .filter((n) => n > 0);

  return dutyRates.reduce((sum, n) => sum + n, 0);
}

function readListRate(block: string, listTag: string) {
  const listBlocks =
    block.match(new RegExp(`<${listTag}\\b[\\s\\S]*?<\\/${listTag}>`, "gi")) ||
    [];

  for (const listBlock of listBlocks) {
    const rate = readFirstAvailableNumber(listBlock, [
      "RATE",
      "PRICE",
      "STANDARDPRICE",
      "STANDARDRATE",
      "FULLPRICE",
      "MRPRATE",
    ]);

    if (rate > 0) return rate;
  }

  return 0;
}

function readStockPrice(
  block: string,
  input: {
    openingQty: number;
    openingRateNumber: number;
    openingValueNumber: number;
    closingQty: number;
    closingValueNumber: number;
  },
) {
  const standardPrice =
    readFirstAvailableNumber(block, [
      "STANDARDPRICE",
      "STANDARDRATE",
      "SELLINGPRICE",
      "SALEPRICE",
      "RATE",
      "MRP",
      "MRPRATE",
    ]) ||
    readListRate(block, "STANDARDPRICELIST.LIST") ||
    readListRate(block, "FULLPRICELIST.LIST") ||
    readListRate(block, "PRICELEVELLIST.LIST");

  if (standardPrice > 0) return standardPrice;
  if (input.openingRateNumber > 0) return input.openingRateNumber;

  if (input.openingQty > 0 && input.openingValueNumber > 0) {
    return input.openingValueNumber / input.openingQty;
  }

  if (input.closingQty > 0 && input.closingValueNumber > 0) {
    return input.closingValueNumber / input.closingQty;
  }

  if (input.openingValueNumber > 0) return input.openingValueNumber;
  if (input.closingValueNumber > 0) return input.closingValueNumber;

  return 0;
}

export function parseLedgers(xml: string) {
  const blocks = xml.match(/<LEDGER\b[\s\S]*?<\/LEDGER>/gi) || [];

  return blocks
    .map((block) => ({
      guid: stripXml(readTag(block, "GUID")),
      masterId: stripXml(readTag(block, "MASTERID")),
      alterId: stripXml(readTag(block, "ALTERID")),
      name: readName(block, "LEDGER"),
      parent: stripXml(readTag(block, "PARENT")),
      email: stripXml(readTag(block, "EMAIL")),
      phone:
        stripXml(readTag(block, "LEDGERPHONE")) ||
        stripXml(readTag(block, "LEDGERMOBILE")) ||
        stripXml(readTag(block, "MOBILE")),
      gstin:
        stripXml(readTag(block, "GSTREGISTRATIONNUMBER")) ||
        stripXml(readTag(block, "PARTYGSTIN")) ||
        stripXml(readTag(block, "GSTIN")),
      address:
        stripXml(readTag(block, "ADDRESS")) ||
        stripXml(readTag(block, "MAILINGADDRESS")),
      state:
        stripXml(readTag(block, "LEDSTATENAME")) ||
        stripXml(readTag(block, "STATENAME")) ||
        stripXml(readTag(block, "STATE")),
      country:
        stripXml(readTag(block, "COUNTRYNAME")) ||
        stripXml(readTag(block, "COUNTRY")) ||
        "India",
      openingBalance: stripXml(readTag(block, "OPENINGBALANCE")),
      closingBalance: stripXml(readTag(block, "CLOSINGBALANCE")),
    }))
    .filter((x) => x.name);
}

export function parseCostCenters(xml: string) {
  const records: any[] = [];

  const blocks =
    String(xml || "").match(/<COSTCENTRE\b[\s\S]*?<\/COSTCENTRE>/gi) || [];

  for (const block of blocks) {
    const nameFromAttr = stripXml(readAttr(block, "COSTCENTRE", "NAME"));
    const nameFromTag = stripXml(readTag(block, "NAME"));

    const name = nameFromAttr || nameFromTag;
    const costCenter = getPrimaryCostCenter(block);

    if (!name) continue;

    records.push({
      guid: stripXml(readTag(block, "GUID")) || null,
      masterId: stripXml(readTag(block, "MASTERID")) || null,
      alterId: stripXml(readTag(block, "ALTERID")) || null,

      name,

      cost_center_name: stripXml(costCenter.cost_center_name || ""),
      cost_category: stripXml(costCenter.cost_category || ""),
      cost_center_amount: costCenter.cost_center_amount,
      cost_center_allocations: costCenter.cost_center_allocations,

      parent: stripXml(readTag(block, "PARENT")) || null,
      category: stripXml(readTag(block, "CATEGORY")) || null,
      description: stripXml(readTag(block, "DESCRIPTION")) || null,
    });
  }

  return records;
}

export function parseStockItems(xml: string) {
  const blocks =
    xml.match(/<STOCKITEM\b[\s\S]*?<\/STOCKITEM>/gi) ||
    xml.match(/<STOCKITEM\b[^>]*\/>/gi) ||
    [];

  return blocks
    .map((block) => {
      const openingBalanceRaw = stripXml(readTag(block, "OPENINGBALANCE"));
      const closingBalanceRaw = stripXml(readTag(block, "CLOSINGBALANCE"));

      const openingRateRaw = stripXml(readTag(block, "OPENINGRATE"));
      const openingValueRaw = stripXml(readTag(block, "OPENINGVALUE"));

      const closingRateRaw = stripXml(readTag(block, "CLOSINGRATE"));
      const closingValueRaw = stripXml(readTag(block, "CLOSINGVALUE"));

      const baseQtyRaw = stripXml(readTag(block, "BASEQTY"));
      const actualQtyRaw = stripXml(readTag(block, "ACTUALQTY"));
      const billedQtyRaw = stripXml(readTag(block, "BILLEDQTY"));

      const openingQty = parseQty(openingBalanceRaw);
      const closingQty = parseQty(closingBalanceRaw);
      const baseQty = parseQty(baseQtyRaw);
      const actualQty = parseQty(actualQtyRaw);
      const billedQty = parseQty(billedQtyRaw);

      const openingRateNumber = toPositiveNumber(openingRateRaw);
      const openingValueNumber = toPositiveNumber(openingValueRaw);

      const closingRateNumber = toPositiveNumber(closingRateRaw);
      const closingValueNumber = toPositiveNumber(closingValueRaw);

      const baseUnit = stripXml(
        readTag(block, "BASEUNITS") ||
          readTag(block, "BASEUNIT") ||
          readTag(block, "UNIT") ||
          readTag(block, "UOM"),
      );

      const partNumber =
        stripXml(readTag(block, "PARTNO")) ||
        stripXml(readTag(block, "PARTNUMBER")) ||
        stripXml(readTag(block, "ITEMCODE")) ||
        stripXml(readTag(block, "STOCKITEMCODE"));

      const description =
        stripXml(readTag(block, "DESCRIPTION")) ||
        stripXml(readTag(block, "NARRATION")) ||
        "";

      const manufacturer =
        stripXml(readTag(block, "MANUFACTURER")) ||
        stripXml(readTag(block, "BRAND")) ||
        "";

      const price = readStockPrice(block, {
        openingQty,
        openingRateNumber,
        openingValueNumber,
        closingQty,
        closingValueNumber,
      });

      const stockOnHand = closingQty || openingQty || baseQty || actualQty || 0;
      const availableForSale = stockOnHand;

      return {
        guid: stripXml(readTag(block, "GUID")),
        masterId: stripXml(readTag(block, "MASTERID")),
        alterId: stripXml(readTag(block, "ALTERID")),

        name: readName(block, "STOCKITEM"),
        parent: stripXml(readTag(block, "PARENT")) || "Uncategorized",

        baseUnit,
        unit: baseUnit,

        partNumber,
        description,
        manufacturer,

        openingBalance: openingBalanceRaw,
        openingRate: openingRateRaw,
        openingValue: openingValueRaw,

        closingBalance: closingBalanceRaw,
        closingRate: closingRateRaw,
        closingValue: closingValueRaw,

        baseQty: baseQtyRaw,
        actualQty: actualQtyRaw,
        billedQty: billedQtyRaw,

        openingQty,
        closingQty,
        baseQtyNumber: baseQty,
        actualQtyNumber: actualQty,
        billedQtyNumber: billedQty,

        openingRateNumber,
        openingValueNumber,
        closingRateNumber,
        closingValueNumber,

        hsnCode: readHsnCode(block),
        gstRate: readGstRate(block),

        price,
        sellingPrice: price,
        costPrice: price,
        msp: price,

        stockOnHand,
        availableForSale,
      };
    })
    .filter((x) => x.name);
}

function toNumberLike(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? Math.abs(num) : 0;
}

function normalizeDate(value?: string | null) {
  if (!value) return null;

  const text = String(value).trim();

  // Tally sometimes gives YYYYMMDD
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  return text;
}

function tallyJulianToDate(value?: string | null) {
  if (!value) return null;

  const jd = Number(String(value).trim());
  if (!Number.isFinite(jd)) return null;

  // Tally JD base: 1900-01-01 => JD 1
  const date = new Date(Date.UTC(1899, 11, 31));
  date.setUTCDate(date.getUTCDate() + jd);

  return date.toISOString().slice(0, 10);
}

function readTallyDate(block: string, tag: string) {
  const textDate = stripXml(readTag(block, tag));
  const normalizedTextDate = normalizeDate(textDate);

  if (normalizedTextDate) return normalizedTextDate;

  const jd = readAttr(block, tag, "JD");
  return tallyJulianToDate(jd);
}

function getDrCr(value?: string | number | null) {
  const text = String(value || "").trim();

  if (text.startsWith("-")) return "Cr";
  if (text) return "Dr";

  return null;
}

function extractBlocks(xml: string, tagName: string) {
  const blocks: string[] = [];
  const regex = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
    "gi",
  );

  let match;

  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }

  return blocks;
}

function normalizeText(value?: string | null) {
  return stripXml(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toSignedNumberLike(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? num : 0;
}

function toAbsNumberLike(value?: string | number | null) {
  return Math.abs(toSignedNumberLike(value));
}

function getVoucherNature(voucherType?: string | null) {
  const type = normalizeText(voucherType);

  if (type === "sales") {
    return {
      billType: "receivable",
      effect: "base",
    };
  }

  if (type === "receipt") {
    return {
      billType: "receivable",
      effect: "adjustment",
    };
  }

  if (type === "purchase") {
    return {
      billType: "payable",
      effect: "base",
    };
  }

  if (type === "payment") {
    return {
      billType: "payable",
      effect: "adjustment",
    };
  }

  return null;
}

function isSameName(a?: string | null, b?: string | null) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  return Boolean(left && right && left === right);
}

function buildOutstandingKey(input: {
  billType: string;
  ledgerName: string;
  billRef: string;
}) {
  return [
    normalizeText(input.billType),
    normalizeText(input.ledgerName),
    normalizeText(input.billRef),
  ].join("::");
}

function normalizeLedgerName(value?: string | null) {
  return stripXml(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function parseTallyLoadedCompany(xml: string) {
  const companyBlocks =
    String(xml || "").match(/<COMPANY[\s\S]*?<\/COMPANY>/gi) || [];

  const companies = companyBlocks
    .map((block) => {
      const nameFromAttr = block.match(/NAME="([^"]+)"/i)?.[1] || "";
      const nameFromTag = readTag(block, "NAME");

      return {
        name: decodeXml(nameFromAttr || nameFromTag),
        guid: decodeXml(readTag(block, "GUID")),
      };
    })
    .filter((item) => item.name);

  const preferredCompanyName =
    process.env.TALLY_COMPANY_NAME?.trim().toLowerCase();

  if (preferredCompanyName) {
    const matched = companies.find(
      (company) => company.name.trim().toLowerCase() === preferredCompanyName,
    );

    if (matched) return matched;
  }

  return companies[0] || null;
}

function isNonPartyOutstandingLedger(ledgerName?: string | null) {
  const name = normalizeLedgerName(ledgerName);

  if (!name) return true;

  const blockedExactNames = new Set([
    "sales account",
    "purchase account",
    "cash",
    "cash in hand",
    "round off",
  ]);

  if (blockedExactNames.has(name)) return true;

  const blockedKeywords = [
    "gst",
    "cgst",
    "sgst",
    "igst",
    "tax",
    "duties",
    "bank",
    "discount",
    "freight",
    "round",
    "sales",
    "purchase",
  ];

  return blockedKeywords.some((keyword) => name.includes(keyword));
}

function parseVoucherOutstandingRows(voucherBlock: string) {
  const voucherDate = readTallyDate(voucherBlock, "DATE");

  const voucherNo =
    stripXml(readTag(voucherBlock, "VOUCHERNUMBER")) ||
    stripXml(readTag(voucherBlock, "REFERENCE")) ||
    stripXml(readTag(voucherBlock, "VCHNO"));

  const voucherGuid =
    stripXml(readTag(voucherBlock, "GUID")) ||
    stripXml(readTag(voucherBlock, "VOUCHERGUID")) ||
    null;

  const voucherType =
    stripXml(readTag(voucherBlock, "VOUCHERTYPENAME")) ||
    readAttr(voucherBlock, "VOUCHER", "VCHTYPE") ||
    null;

  const nature = getVoucherNature(voucherType);

  if (!nature) {
    return [];
  }

  const partyLedgerName =
    stripXml(readTag(voucherBlock, "PARTYLEDGERNAME")) ||
    stripXml(readTag(voucherBlock, "PARTYNAME")) ||
    stripXml(readTag(voucherBlock, "BASICBUYERNAME")) ||
    stripXml(readTag(voucherBlock, "BASICSUPPLIERNAME"));

  const partyLedgerGuid =
    stripXml(readTag(voucherBlock, "PARTYLEDGERGUID")) || null;

  const voucherLevelCostCenter = getPrimaryCostCenter(voucherBlock);

  /**
   * IMPORTANT:
   * Do not combine ALLLEDGERENTRIES and LEDGERENTRIES.
   * Some Tally XML exports contain same ledger in both.
   * Combining both causes double outstanding.
   */
  const allLedgerEntries = extractBlocks(voucherBlock, "ALLLEDGERENTRIES.LIST");
  const normalLedgerEntries = extractBlocks(voucherBlock, "LEDGERENTRIES.LIST");

  const ledgerBlocks = allLedgerEntries.length
    ? allLedgerEntries
    : normalLedgerEntries;

  const rows: any[] = [];

  for (const ledgerBlock of ledgerBlocks) {
    const ledgerName =
      stripXml(readTag(ledgerBlock, "LEDGERNAME")) || partyLedgerName;

    if (!ledgerName) continue;

    if (isNonPartyOutstandingLedger(ledgerName)) {
      continue;
    }

    // Only party ledger bill allocations should be considered.
    if (partyLedgerName && !isSameName(ledgerName, partyLedgerName)) {
      continue;
    }

    const billBlocks = extractBlocks(ledgerBlock, "BILLALLOCATIONS.LIST");

    if (!billBlocks.length) continue;

    const ledgerGuid =
      stripXml(readTag(ledgerBlock, "LEDGERGUID")) ||
      stripXml(readTag(ledgerBlock, "PARTYLEDGERGUID")) ||
      partyLedgerGuid ||
      null;

    const ledgerCostCenter = getPrimaryCostCenter(ledgerBlock);

    const costCenter = ledgerCostCenter.cost_center_name
      ? ledgerCostCenter
      : voucherLevelCostCenter;

    for (const billBlock of billBlocks) {
      const billRef =
        stripXml(readTag(billBlock, "NAME")) ||
        stripXml(readTag(billBlock, "BILLNAME")) ||
        stripXml(readTag(billBlock, "REFERENCE")) ||
        voucherNo;

      if (!billRef) continue;

      const amountRaw =
        stripXml(readTag(billBlock, "AMOUNT")) ||
        stripXml(readTag(ledgerBlock, "AMOUNT"));

      const amount = toAbsNumberLike(amountRaw);

      if (amount <= 0) continue;

      const billDate =
        readTallyDate(billBlock, "BILLDATE") ||
        readTallyDate(billBlock, "DATE") ||
        voucherDate;

      const dueDate =
        readTallyDate(billBlock, "BILLDUEDATE") ||
        readTallyDate(billBlock, "DUEDATE") ||
        billDate ||
        voucherDate;

      rows.push({
        tallyGuid: voucherGuid,
        ledgerGuid,
        ledgerName,

        voucherGuid,
        voucherNumber: voucherNo || billRef,
        voucherNo: voucherNo || billRef,
        voucherType,
        voucherDate,
        dueDate,

        billRef,
        billType: nature.billType,

        effect: nature.effect,
        amount,

        costCenterName: costCenter.cost_center_name || null,
        cost_center_name: costCenter.cost_center_name || null,

        costCategory: costCenter.cost_category || null,
        cost_category: costCenter.cost_category || null,

        costCenterAmount: costCenter.cost_center_amount || 0,
        cost_center_amount: costCenter.cost_center_amount || 0,

        costCenterAllocations: costCenter.cost_center_allocations || [],
        cost_center_allocations: costCenter.cost_center_allocations || [],

        drCr: getDrCr(amountRaw),
        partyType: null,
        voucherKey: stripXml(readTag(voucherBlock, "VOUCHERKEY")) || null,
        voucher_key: stripXml(readTag(voucherBlock, "VOUCHERKEY")) || null,

        masterId: stripXml(readTag(voucherBlock, "MASTERID")) || null,
        master_id: stripXml(readTag(voucherBlock, "MASTERID")) || null,

        alterId: stripXml(readTag(voucherBlock, "ALTERID")) || null,
        alter_id: stripXml(readTag(voucherBlock, "ALTERID")) || null,

        tally_guid: voucherGuid,

        ledger_guid: ledgerGuid,
        ledger_name: ledgerName,

        voucher_guid: voucherGuid,
        voucher_number: voucherNo || billRef,
        voucher_no: voucherNo || billRef,

        voucherTypeName: voucherType,
        voucher_type_name: voucherType,

        voucher_date: voucherDate,
        due_date: dueDate,

        bill_ref: billRef,
        bill_type: nature.billType,

        rawTallyData: voucherBlock,
        raw_tally_data: voucherBlock,
      });
    }
  }

  return rows;
}

function parseVoucherItems(voucherBlock: string) {
  const allInventoryBlocks =
    voucherBlock.match(
      /<ALLINVENTORYENTRIES\.LIST\b[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi,
    ) || [];

  const normalInventoryBlocks =
    voucherBlock.match(
      /<INVENTORYENTRIES\.LIST\b[\s\S]*?<\/INVENTORYENTRIES\.LIST>/gi,
    ) || [];

  const itemBlocks = allInventoryBlocks.length
    ? allInventoryBlocks
    : normalInventoryBlocks;

  return itemBlocks
    .map((itemBlock, index) => {
      const stockItemName =
        stripXml(readTag(itemBlock, "STOCKITEMNAME")) ||
        stripXml(readTag(itemBlock, "NAME"));

      const actualQtyRaw = stripXml(readTag(itemBlock, "ACTUALQTY"));
      const billedQtyRaw = stripXml(readTag(itemBlock, "BILLEDQTY"));
      const rateRaw = stripXml(readTag(itemBlock, "RATE"));
      const amountRaw = stripXml(readTag(itemBlock, "AMOUNT"));

      const quantity =
        parseQty(billedQtyRaw) ||
        parseQty(actualQtyRaw) ||
        toPositiveNumber(amountRaw);

      const rate = toPositiveNumber(rateRaw);
      const amount = toPositiveNumber(amountRaw);

      const hsnCode =
        readHsnCode(itemBlock) ||
        stripXml(readTag(itemBlock, "GSTHSNNAME")) ||
        "NA";

      const gstRate = readGstRate(itemBlock);

      const unit =
        stripXml(readTag(itemBlock, "UNIT")) ||
        stripXml(readTag(itemBlock, "BASEUNITS")) ||
        stripXml(readTag(itemBlock, "STOCKITEMBASEUNITS")) ||
        "";

      const stockItemGuid =
        stripXml(readTag(itemBlock, "STOCKITEMGUID")) ||
        stripXml(readTag(itemBlock, "GUID")) ||
        null;

      return {
        lineNo: index + 1,
        line_no: index + 1,

        stockItemName,
        stock_item_name: stockItemName,

        stockItemGuid,
        stock_item_guid: stockItemGuid,

        description:
          stripXml(readTag(itemBlock, "DESCRIPTION")) ||
          stripXml(readTag(itemBlock, "NARRATION")) ||
          stockItemName,

        actualQty: actualQtyRaw,
        actual_qty: actualQtyRaw,

        billedQty: billedQtyRaw,
        billed_qty: billedQtyRaw,

        quantity,
        qty: quantity,

        rate,
        price: rate,

        amount,
        total: amount,

        unit,

        hsnCode,
        hsn_code: hsnCode,

        gstRate,
        gst_rate: gstRate,

        rawTallyData: itemBlock,
        raw_tally_data: itemBlock,
      };
    })
    .filter((item) => item.stockItemName);
}

export function parseOutstandings(xml: string) {
  const source = String(xml || "");

  const voucherBlocks = extractBlocks(source, "VOUCHER");

  if (voucherBlocks.length) {
    const rawRows = voucherBlocks
      .flatMap((voucherBlock) => parseVoucherOutstandingRows(voucherBlock))
      .filter((row) => row.ledgerName && row.billRef && row.amount > 0);

    const grouped = new Map<string, any>();

    for (const row of rawRows) {
      const key = buildOutstandingKey({
        billType: row.billType,
        ledgerName: row.ledgerName,
        billRef: row.billRef,
      });

      if (!grouped.has(key)) {
        grouped.set(key, {
          ...row,
          baseAmount: 0,
          adjustmentAmount: 0,
        });
      }

      const current = grouped.get(key);

      if (row.effect === "base") {
        current.baseAmount += row.amount;

        // Keep bill details from Sales/Purchase voucher.
        current.tallyGuid = row.tallyGuid;
        current.voucherGuid = row.voucherGuid;
        current.voucherNumber = row.voucherNumber;
        current.voucherNo = row.voucherNo;
        current.voucherType = row.voucherType;
        current.voucherDate = row.voucherDate;
        current.dueDate = row.dueDate;
        current.ledgerGuid = row.ledgerGuid || current.ledgerGuid;

        current.costCenterName = row.costCenterName || current.costCenterName;
        current.cost_center_name =
          row.cost_center_name || current.cost_center_name;

        current.costCategory = row.costCategory || current.costCategory;
        current.cost_category = row.cost_category || current.cost_category;

        current.costCenterAmount =
          row.costCenterAmount || current.costCenterAmount;

        current.cost_center_amount =
          row.cost_center_amount || current.cost_center_amount;

        current.costCenterAllocations =
          row.costCenterAllocations || current.costCenterAllocations;

        current.cost_center_allocations =
          row.cost_center_allocations || current.cost_center_allocations;
      }

      if (row.effect === "adjustment") {
        current.adjustmentAmount += row.amount;
      }
    }

    return Array.from(grouped.values())
      .map((row) => {
        const baseAmount = Number(row.baseAmount || 0);
        const adjustmentAmount = Number(row.adjustmentAmount || 0);

        const pendingAmount = Math.max(0, baseAmount - adjustmentAmount);

        return {
          ...row,

          // Tally Bills Receivable screen shows pending amount.
          billAmount: pendingAmount,
          pendingAmount,
          outstandingAmount: pendingAmount,

          openingAmount: baseAmount,
          adjustmentAmount,
        };
      })
      .filter(
        (row) =>
          row.ledgerName &&
          row.billRef &&
          row.baseAmount > 0 &&
          row.pendingAmount > 0,
      );
  }

  let blocks = extractBlocks(source, "BILLFIXED");

  if (!blocks.length) {
    blocks = extractBlocks(source, "BILL");
  }

  if (!blocks.length) {
    blocks = extractBlocks(source, "BILLS");
  }

  return blocks
    .map((block) => {
      const costCenter = getPrimaryCostCenter(block);

      const ledgerName =
        readTag(block, "BILLPARTY") ||
        readTag(block, "LEDGERNAME") ||
        readTag(block, "PARTYLEDGERNAME") ||
        readTag(block, "PARTYNAME") ||
        readTag(block, "NAME");

      const billRef =
        readAttr(block, "NAME", "NAME") ||
        readTag(block, "BILLNAME") ||
        readTag(block, "REFERENCE") ||
        readTag(block, "REFERENCENUMBER") ||
        readTag(block, "BILLREF") ||
        readTag(block, "NAME");

      const voucherNo =
        readTag(block, "VOUCHERNUMBER") ||
        readTag(block, "VOUCHERNO") ||
        readTag(block, "VCHNO");

      const voucherType =
        readTag(block, "VOUCHERTYPENAME") ||
        readTag(block, "VOUCHERTYPE") ||
        readTag(block, "VCHTYPE");

      const voucherDate =
        readTallyDate(block, "BILLDATE") ||
        readTallyDate(block, "DATE") ||
        readTallyDate(block, "VOUCHERDATE");

      const dueDate =
        readTallyDate(block, "BILLDUEDATE") ||
        readTallyDate(block, "BILLCREDITPERIOD") ||
        readTallyDate(block, "DUEDATE") ||
        voucherDate;

      const openingAmountRaw =
        readTag(block, "BILLOPENING") ||
        readTag(block, "OPENINGBALANCE") ||
        readTag(block, "OPENINGAMOUNT");

      const pendingAmountRaw =
        readTag(block, "BILLCLOSING") ||
        readTag(block, "BILLCL") ||
        readTag(block, "CLOSINGBALANCE") ||
        readTag(block, "PENDINGAMOUNT") ||
        readTag(block, "AMOUNT");

      const overdueDaysRaw =
        readTag(block, "BILLOVERDUE") || readTag(block, "OVERDUEDAYS");

      const openingAmount = toAbsNumberLike(openingAmountRaw);
      const pendingAmount = toAbsNumberLike(pendingAmountRaw);

      return {
        ledgerName,
        ledgerGuid:
          stripXml(readTag(block, "LEDGERGUID")) ||
          stripXml(readTag(block, "PARTYLEDGERGUID")) ||
          stripXml(readTag(block, "MASTERGUID")) ||
          null,

        voucherGuid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        billRef,
        voucherNo: voucherNo || null,
        voucherNumber: voucherNo || null,
        voucherType: voucherType || null,

        voucherDate,
        dueDate,

        billType: "receivable",
        openingAmount,
        billAmount: pendingAmount,
        pendingAmount,
        outstandingAmount: pendingAmount,

        costCenterName: costCenter.cost_center_name || null,
        cost_center_name: costCenter.cost_center_name || null,

        costCategory: costCenter.cost_category || null,
        cost_category: costCenter.cost_category || null,

        costCenterAmount: costCenter.cost_center_amount || 0,
        cost_center_amount: costCenter.cost_center_amount || 0,

        costCenterAllocations: costCenter.cost_center_allocations || [],
        cost_center_allocations: costCenter.cost_center_allocations || [],

        overdueDays: toAbsNumberLike(overdueDaysRaw),

        drCr: getDrCr(pendingAmountRaw || openingAmountRaw),

        partyType: null,
        tallyGuid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        tally_guid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        ledger_guid:
          stripXml(readTag(block, "LEDGERGUID")) ||
          stripXml(readTag(block, "PARTYLEDGERGUID")) ||
          stripXml(readTag(block, "MASTERGUID")) ||
          null,

        ledger_name: ledgerName,

        voucher_guid:
          stripXml(readTag(block, "VOUCHERGUID")) ||
          stripXml(readTag(block, "GUID")) ||
          null,

        voucher_number: voucherNo || null,
        voucher_no: voucherNo || null,

        voucherTypeName: voucherType || null,
        voucher_type_name: voucherType || null,

        voucher_date: voucherDate,
        due_date: dueDate,

        bill_ref: billRef,

        bill_type: "receivable",

        rawTallyData: block,
        raw_tally_data: block,
      };
    })
    .filter(
      (row) =>
        row.ledgerName &&
        row.billRef &&
        row.pendingAmount > 0 &&
        !isNonPartyOutstandingLedger(row.ledgerName),
    );
}

function readBlocks(xml: string, tagName: string) {
  const re = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi");
  return String(xml || "").match(re) || [];
}

function parseVoucherCostCenters(voucherBlock: string) {
  const allocations: Array<{
    guid: string | null;
    name: string;
    category: string | null;
    amount: number;
  }> = [];

  const categoryBlocks = readBlocks(voucherBlock, "CATEGORYALLOCATIONS.LIST");

  for (const categoryBlock of categoryBlocks) {
    const category =
      stripXml(readTag(categoryBlock, "CATEGORY")) ||
      stripXml(readTag(categoryBlock, "NAME")) ||
      null;

    const costCenterBlocks = readBlocks(
      categoryBlock,
      "COSTCENTREALLOCATIONS.LIST",
    );

    for (const ccBlock of costCenterBlocks) {
      const name =
        stripXml(readTag(ccBlock, "NAME")) ||
        stripXml(readTag(ccBlock, "COSTCENTRENAME")) ||
        stripXml(readTag(ccBlock, "COSTCENTERNAME")) ||
        "";

      if (!name) continue;

      const guid =
        stripXml(readTag(ccBlock, "GUID")) ||
        stripXml(readTag(ccBlock, "COSTCENTREGUID")) ||
        stripXml(readTag(ccBlock, "COSTCENTERGUID")) ||
        null;

      const amount = toPositiveNumber(readTag(ccBlock, "AMOUNT"));

      allocations.push({
        guid,
        name,
        category,
        amount,
      });
    }
  }

  // fallback: agar Tally XML me direct COSTCENTREALLOCATIONS.LIST aaye
  if (!allocations.length) {
    const directCostCenterBlocks = readBlocks(
      voucherBlock,
      "COSTCENTREALLOCATIONS.LIST",
    );

    for (const ccBlock of directCostCenterBlocks) {
      const name =
        stripXml(readTag(ccBlock, "NAME")) ||
        stripXml(readTag(ccBlock, "COSTCENTRENAME")) ||
        stripXml(readTag(ccBlock, "COSTCENTERNAME")) ||
        "";

      if (!name) continue;

      const guid =
        stripXml(readTag(ccBlock, "GUID")) ||
        stripXml(readTag(ccBlock, "COSTCENTREGUID")) ||
        stripXml(readTag(ccBlock, "COSTCENTERGUID")) ||
        null;

      const category =
        stripXml(readTag(ccBlock, "CATEGORY")) ||
        stripXml(readTag(ccBlock, "COSTCATEGORY")) ||
        null;

      const amount = toPositiveNumber(readTag(ccBlock, "AMOUNT"));

      allocations.push({
        guid,
        name,
        category,
        amount,
      });
    }
  }

  // duplicate same name/category ko merge kar do
  const merged = new Map<
    string,
    {
      guid: string | null;
      name: string;
      category: string | null;
      amount: number;
    }
  >();

  for (const row of allocations) {
    const key = `${row.guid || ""}::${row.name.toLowerCase()}::${row.category || ""}`;

    const existing = merged.get(key);

    if (existing) {
      existing.amount += row.amount;
    } else {
      merged.set(key, { ...row });
    }
  }

  const finalAllocations = Array.from(merged.values());

  const primary =
    finalAllocations.find((x) => Number(x.amount || 0) > 0) ||
    finalAllocations[0] ||
    null;

  return {
    costCenterGuid: primary?.guid || null,
    costCenterName: primary?.name || null,
    costCategory: primary?.category || null,
    costCenterAmount: primary?.amount || 0,
    costCenterAllocations: finalAllocations,
  };
}

function parseVoucherOrders(xml: string, expectedVoucherType: string) {
  const source = String(xml || "");

  const voucherBlocks = source.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi) || [];

  return voucherBlocks
    .map((block) => {
      const voucherType =
        stripXml(readTag(block, "VOUCHERTYPENAME")) ||
        readAttr(block, "VOUCHER", "VCHTYPE");

      const normalizedVoucherType = normalizeText(voucherType);
      const normalizedExpectedType = normalizeText(expectedVoucherType);

      /**
       * Works for:
       * Sales
       * Sales Order
       * Purchase
       * Purchase Order
       */
      if (
        normalizedExpectedType &&
        !normalizedVoucherType.includes(normalizedExpectedType)
      ) {
        return null;
      }

      const guid =
        stripXml(readTag(block, "GUID")) ||
        stripXml(readTag(block, "VOUCHERGUID")) ||
        null;

      const voucherKey = stripXml(readTag(block, "VOUCHERKEY")) || null;
      const masterId = stripXml(readTag(block, "MASTERID")) || null;
      const alterId = stripXml(readTag(block, "ALTERID")) || null;

      const voucherDate =
        readTallyDate(block, "DATE") ||
        normalizeDate(stripXml(readTag(block, "DATE")));

      const voucherNumber =
        stripXml(readTag(block, "VOUCHERNUMBER")) ||
        stripXml(readTag(block, "REFERENCE")) ||
        stripXml(readTag(block, "VCHNO")) ||
        "";

      const partyLedgerName =
        stripXml(readTag(block, "PARTYLEDGERNAME")) ||
        stripXml(readTag(block, "PARTYNAME")) ||
        stripXml(readTag(block, "BASICBUYERNAME")) ||
        stripXml(readTag(block, "BASICSUPPLIERNAME"));

      const partyGuid =
        stripXml(readTag(block, "PARTYLEDGERGUID")) ||
        stripXml(readTag(block, "LEDGERGUID")) ||
        null;

      const items = parseVoucherItems(block);

      const itemsTotal = items.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      const voucherAmount = toPositiveNumber(readTag(block, "AMOUNT"));
      const totalAmount = voucherAmount || itemsTotal;

      const costCenterData = parseVoucherCostCenters(block);

      const referenceNumber = readVoucherReferenceNumber(block);

      const basicOrderRef = stripXml(readTag(block, "BASICORDERREF")) || "";
      const basicBuyerOrderNo =
        stripXml(readTag(block, "BASICBUYERORDERNO")) || "";

      const orderRef =
        stripXml(readTag(block, "ORDERREFERENCE")) ||
        stripXml(readTag(block, "ORDERREF")) ||
        "";

      const dueDate =
        readTallyDate(block, "BASICDUEDATEOFPYMT") ||
        normalizeDate(stripXml(readTag(block, "BASICDUEDATEOFPYMT")));

      const narration = stripXml(readTag(block, "NARRATION"));

      return {
        /**
         * Old/current aliases
         */
        guid,
        voucherKey,
        masterId,
        alterId,
        voucherNumber,
        voucherType,
        voucherDate,
        partyName: partyLedgerName,
        partyGuid,
        referenceNumber,
        basicOrderRef,
        basicBuyerOrderNo,
        orderRef,
        dueDate,
        narration,
        totalAmount,
        items,

        costCenterGuid: costCenterData.costCenterGuid,
        costCenterName: costCenterData.costCenterName,
        costCategory: costCenterData.costCategory,
        costCenterAmount: costCenterData.costCenterAmount,
        costCenterAllocations: costCenterData.costCenterAllocations,

        /**
         * Backend/CRM safe aliases
         */
        tallyGuid: guid,
        tally_guid: guid,

        voucherGuid: guid,
        voucher_guid: guid,

        voucher_key: voucherKey,

        master_id: masterId,

        alter_id: alterId,

        voucherNo: voucherNumber,
        voucher_no: voucherNumber,

        voucher_number: voucherNumber,

        voucherTypeName: voucherType,
        voucher_type_name: voucherType,

        partyLedgerName,
        party_ledger_name: partyLedgerName,

        party_name: partyLedgerName,

        partyLedgerGuid: partyGuid,
        party_ledger_guid: partyGuid,

        reference: referenceNumber,
        reference_number: referenceNumber,

        basic_order_ref: basicOrderRef,
        basic_buyer_order_no: basicBuyerOrderNo,
        order_ref: orderRef,

        amount: totalAmount,
        total_amount: totalAmount,

        cost_center_guid: costCenterData.costCenterGuid,
        cost_center_name: costCenterData.costCenterName,
        cost_category: costCenterData.costCategory,
        cost_center_amount: costCenterData.costCenterAmount,
        cost_center_allocations: costCenterData.costCenterAllocations,

        rawTallyData: block,
        raw_tally_data: block,
      };
    })
    .filter(Boolean);
}

export function parseSalesOrders(xml: string) {
  return parseVoucherOrders(xml, "Sales");
}

export function parsePurchaseOrders(xml: string) {
  return parseVoucherOrders(xml, "Purchase");
}
