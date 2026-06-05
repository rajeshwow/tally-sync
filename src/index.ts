import cors from "cors";
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cron from "node-cron";
import { updateTallyConnectionInCrm } from "./crm.client";
import { runHistoricalSync } from "./historical-sync.service";
import { parseTallyLoadedCompany } from "./mapper";
import { runFullSync } from "./sync.service";
import { fetchTallyCompaniesXml } from "./tally.client";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || process.env.TALLY_AGENT_PORT || 5055);
const SYNC_CRON = process.env.SYNC_CRON || "*/10 * * * *";

let isManualSyncRunning = false;
let lastManualSyncAt: string | null = null;
let lastManualSyncStartedAt: string | null = null;
let lastManualSyncCompletedAt: string | null = null;
let lastManualSyncStatus: "idle" | "running" | "success" | "failed" = "idle";
let lastManualSyncError: string | null = null;
let lastManualSyncResult: any = null;

function requireControlToken(req: Request, res: Response, next: NextFunction) {
  const expectedToken = process.env.TALLY_AGENT_TOKEN || "";
  const authHeader = req.headers.authorization || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (!expectedToken) {
    return res.status(500).json({
      statusCode: 500,
      message: "TALLY_AGENT_TOKEN is missing in tally sync agent",
      data: null,
    });
  }

  if (!token || token !== expectedToken) {
    return res.status(401).json({
      statusCode: 401,
      message: "Invalid tally agent control token",
      data: null,
    });
  }

  return next();
}

function getAgentStatus() {
  return {
    service: "tally-sync-agent",
    status: lastManualSyncStatus,
    is_running: isManualSyncRunning,
    last_manual_sync_at: lastManualSyncAt,
    last_manual_sync_started_at: lastManualSyncStartedAt,
    last_manual_sync_completed_at: lastManualSyncCompletedAt,
    last_error: lastManualSyncError,
    last_result: lastManualSyncResult,
    time: new Date().toISOString(),
  };
}

/**
 * CRM backend will call this API for connection check.
 */
app.get("/health", requireControlToken, (_req: Request, res: Response) => {
  return res.json({
    statusCode: 200,
    message: "Tally sync agent is reachable",
    data: getAgentStatus(),
  });
});

/**
 * CRM backend will call this API from frontend Run Sync button.
 * This returns immediately and sync runs in background.
 */
app.post(
  "/sync/run",
  requireControlToken,
  async (_req: Request, res: Response) => {
    if (isManualSyncRunning) {
      return res.status(409).json({
        statusCode: 409,
        message: "Tally sync is already running",
        data: getAgentStatus(),
      });
    }

    async function syncTallyCompanyToCrm() {
      const companiesXml = await fetchTallyCompaniesXml();
      const company = parseTallyLoadedCompany(companiesXml);

      await updateTallyConnectionInCrm({
        companyName: company?.name || null,
        companyGuid: company?.guid || null,
        tallyUrl: process.env.TALLY_URL || "http://localhost:9000",
        direction: "pull",
        frequencyMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || 10),
        isActive: true,
      });

      console.log("[TALLY COMPANY]", company || "No loaded company found");
    }

    isManualSyncRunning = true;
    lastManualSyncStatus = "running";
    lastManualSyncStartedAt = new Date().toISOString();
    lastManualSyncCompletedAt = null;
    lastManualSyncError = null;
    lastManualSyncResult = null;

    res.json({
      statusCode: 200,
      message: "Tally sync started",
      data: getAgentStatus(),
    });

    try {
      console.log(`[MANUAL SYNC] Started at ${lastManualSyncStartedAt}`);

      await syncTallyCompanyToCrm();

      const result = await runFullSync();

      lastManualSyncAt = new Date().toISOString();
      lastManualSyncCompletedAt = lastManualSyncAt;
      lastManualSyncStatus = "success";
      lastManualSyncResult = result;

      console.log("[MANUAL SYNC] Completed", JSON.stringify(result));
    } catch (error: any) {
      lastManualSyncCompletedAt = new Date().toISOString();
      lastManualSyncStatus = "failed";
      lastManualSyncError = error?.message || "Manual sync failed";

      console.error("[MANUAL SYNC] Failed", error?.message || error);
    } finally {
      isManualSyncRunning = false;
    }
  },
);

/**
 * Optional old route.
 * Keep it for local testing but secure it also.
 */
app.post(
  "/sync-now",
  requireControlToken,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (isManualSyncRunning) {
        return res.status(409).json({
          statusCode: 409,
          message: "Tally sync is already running",
          data: getAgentStatus(),
        });
      }

      isManualSyncRunning = true;
      lastManualSyncStatus = "running";
      lastManualSyncStartedAt = new Date().toISOString();
      lastManualSyncCompletedAt = null;
      lastManualSyncError = null;
      lastManualSyncResult = null;

      const result = await runFullSync();

      lastManualSyncAt = new Date().toISOString();
      lastManualSyncCompletedAt = lastManualSyncAt;
      lastManualSyncStatus = "success";
      lastManualSyncResult = result;

      return res.json({
        statusCode: 200,
        message: "Tally sync completed",
        data: {
          ...getAgentStatus(),
          result,
        },
      });
    } catch (error: any) {
      lastManualSyncCompletedAt = new Date().toISOString();
      lastManualSyncStatus = "failed";
      lastManualSyncError = error?.message || "Manual sync failed";

      next(error);
    } finally {
      isManualSyncRunning = false;
    }
  },
);

app.post("/sync/historical", async (req, res) => {
  try {
    const result = await runHistoricalSync({
      startYear: Number(req.body?.startYear || 2022),
      companyName: req.body?.companyName || undefined,
    });

    return res.status(200).json({
      statusCode: 200,
      message: "Historical sync completed",
      data: result,
    });
  } catch (error: any) {
    console.error("[HISTORICAL SYNC] Failed", error);

    return res.status(500).json({
      statusCode: 500,
      message: "Historical sync failed",
      data: {
        error: error?.message || "Unknown error",
      },
    });
  }
});

cron.schedule(SYNC_CRON, async () => {
  try {
    if (isManualSyncRunning) {
      console.log("[CRON SYNC] Skipped because manual sync is running");
      return;
    }

    console.log(`[CRON SYNC] Started at ${new Date().toISOString()}`);

    const result = await runFullSync();

    console.log("[CRON SYNC] Completed", JSON.stringify(result));
  } catch (error: any) {
    console.error("[CRON SYNC] Failed", error?.message || error);
  }
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[AGENT ERROR]", error?.message || error);

  return res.status(500).json({
    statusCode: 500,
    message: error?.message || "Tally sync agent error",
    data: null,
  });
});

app.listen(PORT, () => {
  console.log(`Tally Sync Agent running on port ${PORT}`);
});
