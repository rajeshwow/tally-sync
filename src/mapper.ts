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
    .replace(/<[^>]+>/g, "")
    .replace(/&#4;/g, "")
    .replace(/Not Applicable/gi, "")
    .replace(/Not Found/gi, "")
    .replace(/As per Company\/Stock Group/gi, "")
    .replace(/Not Available/gi, "")
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
    const category = readTag(categoryBlock, "CATEGORY") || null;

    const ccBlocks =
      categoryBlock.match(
        /<COSTCENTREALLOCATIONS\.LIST[\s\S]*?<\/COSTCENTREALLOCATIONS\.LIST>/gi,
      ) || [];

    for (const ccBlock of ccBlocks) {
      const name = readTag(ccBlock, "NAME");

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

  const blocks = xml.match(/<COSTCENTRE[\s\S]*?<\/COSTCENTRE>/gi) || [];

  for (const block of blocks) {
    const nameFromAttr = readAttr(block, "COSTCENTRE", "NAME");
    const nameFromTag = readTag(block, "NAME");

    const name = nameFromAttr || nameFromTag;
    const costCenter = getPrimaryCostCenter(block);

    if (!name) continue;

    records.push({
      guid: readTag(block, "GUID") || null,
      name,
      cost_center_name: costCenter.cost_center_name,
      cost_category: costCenter.cost_category,
      cost_center_amount: costCenter.cost_center_amount,
      cost_center_allocations: costCenter.cost_center_allocations,
      parent: readTag(block, "PARENT") || null,
      category: readTag(block, "CATEGORY") || null,
      description: readTag(block, "DESCRIPTION") || null,
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
      });
    }
  }

  return rows;
}

function parseVoucherItems(voucherBlock: string) {
  const itemBlocks =
    voucherBlock.match(
      /<ALLINVENTORYENTRIES\.LIST\b[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi,
    ) || [];

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

      return {
        lineNo: index + 1,

        stockItemName,
        stockItemGuid:
          stripXml(readTag(itemBlock, "STOCKITEMGUID")) ||
          stripXml(readTag(itemBlock, "GUID")) ||
          null,

        description:
          stripXml(readTag(itemBlock, "DESCRIPTION")) ||
          stripXml(readTag(itemBlock, "NARRATION")) ||
          stockItemName,

        actualQty: actualQtyRaw,
        billedQty: billedQtyRaw,

        quantity,
        rate,
        amount,

        unit:
          stripXml(readTag(itemBlock, "UNIT")) ||
          stripXml(readTag(itemBlock, "BASEUNITS")) ||
          "",

        hsnCode,
        gstRate,
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

function parseVoucherOrders(xml: string, expectedVoucherType: string) {
  const source = String(xml || "");

  const voucherBlocks = source.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/gi) || [];

  return voucherBlocks
    .map((block) => {
      const voucherType =
        stripXml(readTag(block, "VOUCHERTYPENAME")) ||
        readAttr(block, "VOUCHER", "VCHTYPE");

      if (
        expectedVoucherType &&
        voucherType.toLowerCase() !== expectedVoucherType.toLowerCase()
      ) {
        return null;
      }

      const voucherDate = normalizeDate(stripXml(readTag(block, "DATE")));

      const partyName =
        stripXml(readTag(block, "PARTYLEDGERNAME")) ||
        stripXml(readTag(block, "PARTYNAME")) ||
        stripXml(readTag(block, "BASICBUYERNAME")) ||
        stripXml(readTag(block, "BASICSUPPLIERNAME"));

      const items = parseVoucherItems(block);

      const itemsTotal = items.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      const voucherAmount = toPositiveNumber(readTag(block, "AMOUNT"));

      return {
        guid: stripXml(readTag(block, "GUID")),
        voucherKey: stripXml(readTag(block, "VOUCHERKEY")),
        masterId: stripXml(readTag(block, "MASTERID")),
        alterId: stripXml(readTag(block, "ALTERID")),

        voucherNumber:
          stripXml(readTag(block, "VOUCHERNUMBER")) ||
          stripXml(readTag(block, "REFERENCE")) ||
          "",

        voucherType,
        voucherDate,

        partyName,
        partyGuid:
          stripXml(readTag(block, "PARTYLEDGERGUID")) ||
          stripXml(readTag(block, "LEDGERGUID")) ||
          null,

        referenceNumber:
          stripXml(readTag(block, "REFERENCE")) ||
          stripXml(readTag(block, "BASICORDERREF")) ||
          "",

        dueDate: normalizeDate(stripXml(readTag(block, "BASICDUEDATEOFPYMT"))),

        narration: stripXml(readTag(block, "NARRATION")),

        totalAmount: voucherAmount || itemsTotal,

        items,
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
