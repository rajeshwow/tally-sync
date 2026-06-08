import fs from "fs";
import path from "path";

export type CheckpointModuleStatus = "success" | "failed" | "running";

export type SyncCheckpointRecord = {
  key: string;
  mode: "historical" | "incremental";
  companyName: string;
  companyGuid?: string | null;
  moduleName: string;
  fromDate?: string | null;
  toDate?: string | null;
  status: CheckpointModuleStatus;
  totalRecords?: number;
  uploadedRecords?: number;
  failedRecords?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
};

type CheckpointFileShape = {
  version: number;
  updatedAt: string | null;
  records: Record<string, SyncCheckpointRecord>;
};

const CHECKPOINT_FILE = path.resolve(
  process.cwd(),
  process.env.SYNC_CHECKPOINT_FILE || ".tally-sync-checkpoints.json",
);

function nowIso() {
  return new Date().toISOString();
}

function normalize(value: any) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function safeDate(value?: string | null) {
  return value || "master";
}

function emptyStore(): CheckpointFileShape {
  return {
    version: 1,
    updatedAt: null,
    records: {},
  };
}

function readStore(): CheckpointFileShape {
  try {
    if (!fs.existsSync(CHECKPOINT_FILE)) {
      return emptyStore();
    }

    const parsed = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));

    return {
      version: Number(parsed?.version || 1),
      updatedAt: parsed?.updatedAt || null,
      records:
        parsed?.records && typeof parsed.records === "object"
          ? parsed.records
          : {},
    };
  } catch (error: any) {
    console.error("[SYNC CHECKPOINT] Failed to read checkpoint file", {
      file: CHECKPOINT_FILE,
      message: error?.message,
    });

    return emptyStore();
  }
}

function writeStore(store: CheckpointFileShape) {
  const dir = path.dirname(CHECKPOINT_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpFile = `${CHECKPOINT_FILE}.tmp`;
  store.updatedAt = nowIso();

  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, CHECKPOINT_FILE);
}

export function buildSyncCheckpointKey(input: {
  mode?: "historical" | "incremental";
  companyName?: string | null;
  companyGuid?: string | null;
  moduleName: string;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  return [
    input.mode || "historical",
    normalize(input.companyGuid || input.companyName || "company"),
    normalize(input.moduleName),
    safeDate(input.fromDate),
    safeDate(input.toDate),
  ].join("|");
}

export function getSyncCheckpoint(input: {
  mode?: "historical" | "incremental";
  companyName?: string | null;
  companyGuid?: string | null;
  moduleName: string;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  const store = readStore();
  const key = buildSyncCheckpointKey(input);
  return store.records[key] || null;
}

export function isSyncCheckpointSuccess(input: {
  mode?: "historical" | "incremental";
  companyName?: string | null;
  companyGuid?: string | null;
  moduleName: string;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  return getSyncCheckpoint(input)?.status === "success";
}

export function markSyncCheckpoint(input: Omit<SyncCheckpointRecord, "key">) {
  const store = readStore();
  const key = buildSyncCheckpointKey(input);
  const existing = store.records[key];

  store.records[key] = {
    ...existing,
    ...input,
    key,
    startedAt: input.startedAt || existing?.startedAt || nowIso(),
    completedAt: input.completedAt ?? existing?.completedAt ?? null,
  };

  writeStore(store);
  return store.records[key];
}

export function clearHistoricalSyncCheckpoints(input?: {
  companyName?: string | null;
  companyGuid?: string | null;
}) {
  const store = readStore();
  const companyKey = normalize(input?.companyGuid || input?.companyName || "");

  for (const key of Object.keys(store.records)) {
    const record = store.records[key];

    if (record.mode !== "historical") continue;

    if (companyKey) {
      const recordCompanyKey = normalize(
        record.companyGuid || record.companyName,
      );
      if (recordCompanyKey !== companyKey) continue;
    }

    delete store.records[key];
  }

  writeStore(store);
}

export function listHistoricalSyncCheckpoints() {
  const store = readStore();
  return Object.values(store.records).filter(
    (record) => record.mode === "historical",
  );
}
