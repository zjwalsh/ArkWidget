export class AriesApiClient {
  constructor(config) {
    this.forwardPath = config.ariesForwardPath;
    this.newCallEndpoint = config.ariesNewCallEndpoint ?? "/contact-arrivals";
    this.recordTransactionEndpoint = config.ariesRecordTransactionEndpoint ?? "/recordtransaction";
  }

  async sendAgentEvent(event) {
    return this.forward({
      endpoint: "/agent-events",
      method: "POST",
      body: event
    });
  }

  async sendCommandResult(command, result, error = null) {
    return this.forward({
      endpoint: "/command-results",
      method: "POST",
      body: {
        command,
        result,
        error
      }
    });
  }

  async sendNewCallEvent(event) {
    return this.forward({
      endpoint: this.newCallEndpoint,
      method: "POST",
      body: event
    });
  }

  async sendRecordTransactionEvent(event) {
    return this.forward({
      endpoint: this.recordTransactionEndpoint,
      method: "POST",
      body: event
    });
  }

  async sendCapturedAudio(command, captureResult) {
    const delivery = command?.payload?.delivery ?? {};
    const endpoint = typeof delivery.endpoint === "string" && delivery.endpoint.startsWith("/")
      ? delivery.endpoint
      : "/telephonic-signatures";
    const method = typeof delivery.method === "string" ? delivery.method : "POST";
    const extraBody = isPlainObject(delivery.extraBody) ? delivery.extraBody : {};
    const metadata = isPlainObject(captureResult?.metadata) ? captureResult.metadata : {};
    const body = {
      dialogId: firstNonEmptyValue(metadata.dialogId, metadata.interactionId),
      docTypeId: metadata.docTypeId ?? 1026,
      docTypeName: firstNonEmptyValue(metadata.docTypeName, "Telephonic Signature Recording"),
      receivedDt: firstNonEmptyValue(metadata.receivedDt, formatTodayDate()),
      scanDt: firstNonEmptyValue(metadata.scanDt, formatTodayDate()),
      caseNum: firstNonEmptyValue(metadata.caseNum),
      appNum: firstNonEmptyValue(metadata.appNum),
      indvId: firstNonEmptyValue(metadata.indvId),
      source: firstNonEmptyValue(metadata.source, "FIN"),
      lastName: firstNonEmptyValue(metadata.lastName),
      firstName: firstNonEmptyValue(metadata.firstName),
      midName: firstNonEmptyValue(metadata.midName),
      suffix: firstNonEmptyValue(metadata.suffix, metadata.sufxName),
      dob: firstNonEmptyValue(metadata.dob, metadata.dobDt),
      docBlob: captureResult?.audioBase64 ?? null,
      fileType: firstNonEmptyValue(metadata.fileType, "WAV"),
      ...extraBody
    };

    if (delivery.includeCommand === true) {
      body.command = command;
    }

    return this.forward({
      endpoint,
      method,
      useUploadApi: command?.type === "confirmAudioCapture",
      body
    });
  }

  async forward(payload) {
    const body = safeJsonStringify(payload);
    const response = await fetch(this.forwardPath, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body
    });

    const text = await response.text();
    const data = tryParseJson(text);

    if (!response.ok) {
      throw new Error(data?.error ?? `Third-party request failed with status ${response.status}`);
    }

    return data ?? text;
  }
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    return value;
  }

  return null;
}

function formatTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonStringify(value) {
  const seen = new WeakSet();

  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "function") {
      return undefined;
    }

    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack
      };
    }

    if (currentValue instanceof Map) {
      return Object.fromEntries(currentValue.entries());
    }

    if (currentValue instanceof Set) {
      return Array.from(currentValue.values());
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }

      seen.add(currentValue);
    }

    return currentValue;
  });
}
