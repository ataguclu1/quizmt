import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { setupSocketIO } from "./game-socket";
import { ensureSchema } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
setupSocketIO(httpServer);

// Make sure the database schema exists before we start accepting requests.
// Non-fatal: if the DB is unreachable we still boot (and log loudly) so the
// frontend keeps working and the real cause is visible in the deploy logs.
try {
  await ensureSchema();
  logger.info("Database schema verified");
} catch (err) {
  logger.error(
    { err },
    "ensureSchema failed — database unreachable or misconfigured (check DATABASE_URL / SSL)",
  );
}

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});

httpServer.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
