import "dotenv/config";
import { createArkWidgetApp } from "./app.js";
import { logError, logInfo } from "./logger.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createArkWidgetApp();

app.listen(port, () => {
  logInfo("Ark WXCC widget host listening", {
    port,
    mountPath: app.locals.arkWidgetMountPath,
    url: `http://localhost:${port}${app.locals.arkWidgetMountPath}`
  });
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", { error });
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", {
    error: reason instanceof Error ? reason : new Error(String(reason))
  });
});
