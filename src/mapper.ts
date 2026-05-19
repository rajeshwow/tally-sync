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

function toNumber(value: any) {
  const cleaned = stripXml(String(value || ""))
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
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

export function parseOutstandings(xml: string) {
  const source = String(xml || "");

  let blocks = extractBlocks(source, "BILLFIXED");

  if (!blocks.length) {
    blocks = extractBlocks(source, "BILL");
  }

  if (!blocks.length) {
    blocks = extractBlocks(source, "BILLS");
  }

  return blocks
    .map((block) => {
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

      const openingAmount = toNumberLike(openingAmountRaw);
      const pendingAmount = toNumberLike(pendingAmountRaw);

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
        voucherType: voucherType || null,

        voucherDate,
        dueDate,

        openingAmount,
        pendingAmount,

        overdueDays: toNumberLike(overdueDaysRaw),

        drCr: getDrCr(pendingAmountRaw || openingAmountRaw),

        partyType: null,
      };
    })
    .filter((row) => row.ledgerName && row.billRef);
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
