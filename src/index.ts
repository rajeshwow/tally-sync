import cors from "cors";
import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { runFullSync } from "./sync.service";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 5050);
const SYNC_CRON = process.env.SYNC_CRON || "*/10 * * * *";

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "tally-sync-agent",
    time: new Date().toISOString(),
  });
});

app.post("/sync-now", async (_req, res, next) => {
  try {
    const result = await runFullSync();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

cron.schedule(SYNC_CRON, async () => {
  try {
    console.log(`[SYNC] Started at ${new Date().toISOString()}`);
    const result = await runFullSync();
    console.log("[SYNC] Completed", JSON.stringify(result));
  } catch (error: any) {
    console.error("[SYNC] Failed", error?.message || error);
  }
});

app.listen(PORT, () => {
  console.log(`Tally Sync Agent running on port ${PORT}`);
});
