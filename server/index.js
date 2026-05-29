import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createArkWidgetApp } from "./app.js";
import { logError, logInfo } from "./logger.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createArkWidgetApp();
const httpsCertPath = process.env.HTTPS_CERT_PATH ?? process.env.TAILSCALE_CERT_PATH ?? "";
const httpsKeyPath = process.env.HTTPS_KEY_PATH ?? process.env.TAILSCALE_KEY_PATH ?? "";

const server = createServer({ app, httpsCertPath, httpsKeyPath });

server.listen(port, () => {
  const protocol = server instanceof https.Server ? "https" : "http";
  logInfo("Ark WXCC widget host listening", {
    port,
    protocol,
    mountPath: app.locals.arkWidgetMountPath,
    url: `${protocol}://localhost:${port}${app.locals.arkWidgetMountPath}`,
    httpsCertPath: httpsCertPath || undefined,
    httpsKeyPath: httpsKeyPath || undefined
  });
});

function createServer({ app, httpsCertPath, httpsKeyPath }) {
  if (!httpsCertPath && !httpsKeyPath) {
    return http.createServer(app);
  }

  if (!httpsCertPath || !httpsKeyPath) {
    throw new Error("HTTPS_CERT_PATH and HTTPS_KEY_PATH must both be set when enabling HTTPS.");
  }

  return https.createServer(
    {
      cert: fs.readFileSync(httpsCertPath),
      key: fs.readFileSync(httpsKeyPath)
    },
    app
  );
}

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", { error });
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", {
    error: reason instanceof Error ? reason : new Error(String(reason))
  });
});
