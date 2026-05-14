import { Logger } from "@aws-lambda-powertools/logger";
import fs from "node:fs";
import path from "node:path";

const serviceName = process.env.POWERTOOLS_SERVICE_NAME ?? process.env.WIDGET_NAME ?? "ark-wxcc-widget-host";
const logLevel = process.env.LOG_LEVEL ?? "INFO";
const logToFile = ["1", "true", "yes", "on"].includes(String(process.env.LOG_TO_FILE ?? "false").toLowerCase());
const logFilePath = process.env.LOG_FILE_PATH ?? path.resolve(process.cwd(), "logs", "server.log");

const baseLogger = new Logger({
  serviceName,
  logLevel
});

const fileLogStream = createFileLogStream();

export function logInfo(message, attributes = {}) {
  writeLogEntry("INFO", message, attributes);
}

export function logWarn(message, attributes = {}) {
  writeLogEntry("WARN", message, attributes);
}

export function logError(message, attributes = {}) {
  writeLogEntry("ERROR", message, attributes);
}

export function logDebug(message, attributes = {}) {
  writeLogEntry("DEBUG", message, attributes);
}

export function buildRequestContext(request) {
  return {
    requestId: request.requestId,
    method: request.method,
    path: request.originalUrl ?? request.url,
    ip: request.ip,
    userAgent: request.get("user-agent") ?? null
  };
}

function sanitizeLogAttributes(attributes) {
  return JSON.parse(JSON.stringify(attributes, (_key, value) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    return value;
  }));
}

function writeLogEntry(level, message, attributes) {
  const sanitizedAttributes = sanitizeLogAttributes(attributes);

  switch (level) {
    case "DEBUG":
      baseLogger.debug(message, sanitizedAttributes);
      break;
    case "WARN":
      baseLogger.warn(message, sanitizedAttributes);
      break;
    case "ERROR":
      baseLogger.error(message, sanitizedAttributes);
      break;
    default:
      baseLogger.info(message, sanitizedAttributes);
      break;
  }

  if (fileLogStream) {
    const serializedEntry = JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      service: serviceName,
      ...sanitizedAttributes
    });

    fileLogStream.write(`${serializedEntry}\n`);
  }
}

function createFileLogStream() {
  if (!logToFile) {
    return null;
  }

  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  return fs.createWriteStream(logFilePath, { flags: "a" });
}