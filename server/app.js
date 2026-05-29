import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequestContext, logDebug, logError, logInfo, logWarn } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");
const nodeModulesDir = path.resolve(__dirname, "../node_modules");
const recordingsDir = path.resolve(__dirname, "../logs/recordings");
const commandResultsDir = path.resolve(__dirname, "../logs/command-results");
const widgetAssetVersion = Date.now().toString();

export function createArkWidgetApp(options = {}) {
  const mountPath = normalizeMountPath(options.mountPath ?? process.env.WIDGET_BASE_PATH ?? "/");
  const publicOrigin = normalizePublicOrigin(options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? "");
  const ariesBaseUrl = options.ariesBaseUrl
    ?? process.env.ARIES_API_BASE_URL
    ?? "";
  const ariesUploadUrl = options.ariesUploadUrl
    ?? process.env.ARIES_API_UPLOAD_URL
    ?? "";
  const ariesApiKey = options.ariesApiKey
    ?? process.env.ARIES_API_KEY
    ?? "";
  const ariesCommandUsername = normalizeOptionalString(
    options.ariesCommandUsername
    ?? process.env.ARIES_COMMAND_USERNAME
  );
  const ariesCommandPassword = normalizeOptionalString(
    options.ariesCommandPassword
    ?? process.env.ARIES_COMMAND_PASSWORD
  );
  const requiresCommandAuth = Boolean(ariesCommandUsername || ariesCommandPassword);
  const ariesTimeoutMs = Number.parseInt(
    String(
      options.ariesTimeoutMs
      ?? process.env.ARIES_API_TIMEOUT_MS
      ?? "10000"
    ),
    10
  );
  const ariesNewCallEndpoint = options.ariesNewCallEndpoint
    ?? process.env.ARIES_NEW_CALL_ENDPOINT
    ?? "/contact-arrivals";
  const ariesRecordTransactionEndpoint = options.ariesRecordTransactionEndpoint
    ?? process.env.ARIES_RECORD_TRANSACTION_ENDPOINT
    ?? "/recordtransaction";
  const trackedCallAssociatedDataFields = buildTrackedCallAssociatedDataFields({
    consentRecordingFieldName: options.ariesConsentRecordingFieldName
      ?? process.env.ARIES_CONSENT_RECORDING_FIELD_NAME,
    consentScriptPlayedFieldName: options.ariesConsentScriptPlayedFieldName
      ?? process.env.ARIES_CONSENT_SCRIPT_PLAYED_FIELD_NAME
  });
  const trackedCallAssociatedDataState = {
    byInteractionId: new Map(),
    latestTrackedCallAssociatedData: null
  };
  const callLifecycleState = {
    callStartTimeByInteractionId: new Map()
  };


  const requireAgentDesktop = toBoolean(options.requireAgentDesktop ?? process.env.REQUIRE_AGENT_DESKTOP, true);
  const sseClients = new Set();
  const router = express.Router();

  router.use((request, response, next) => {
    request.requestId = request.get("x-request-id") ?? crypto.randomUUID();
    response.setHeader("x-request-id", request.requestId);

    const startedAt = Date.now();
    logInfo("Incoming request", buildRequestContext(request));

    response.on("finish", () => {
      logInfo("Request completed", {
        ...buildRequestContext(request),
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt
      });
    });

    next();
  });

  router.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  });

  router.use((request, response, next) => {
    if (request.method === "GET" && isWidgetAssetRequest(request.path)) {
      response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      response.setHeader("Pragma", "no-cache");
      response.setHeader("Expires", "0");
      response.setHeader("Surrogate-Control", "no-store");
      response.setHeader("x-ark-widget-version", widgetAssetVersion);
    }

    next();
  });

  router.use(express.static(publicDir));
  router.use("/vendor", express.static(nodeModulesDir));

  router.get("/health", (_request, response) => {
    response.json({ ok: true, mountPath });
  });

  router.get("/config.js", (request, response) => {
    const runtimeOrigin = publicOrigin || getRequestOrigin(request);
    const config = {
      widgetName: options.widgetName ?? process.env.WIDGET_NAME ?? "ark-widget",
      widgetProvider: options.widgetProvider ?? process.env.WIDGET_PROVIDER ?? "ArkWidget",
      basePath: mountPath,
      assetVersion: widgetAssetVersion,
      sdkScriptPath: toRuntimeUrl(runtimeOrigin, joinMountPath(mountPath, "/vendor/@wxcc-desktop/sdk/dist/index.js")),
      ariesForwardPath: toRuntimeUrl(runtimeOrigin, joinMountPath(mountPath, "/api/third-party/forward")),
      ariesNewCallEndpoint,
      ariesRecordTransactionEndpoint,
      thirdPartyForwardPath: toRuntimeUrl(runtimeOrigin, joinMountPath(mountPath, "/api/third-party/forward")),
      thirdPartyNewCallEndpoint: ariesNewCallEndpoint,
      commandStreamPath: toRuntimeUrl(runtimeOrigin, joinMountPath(mountPath, "/events")),
      desktopRegistrationPath: toRuntimeUrl(runtimeOrigin, joinMountPath(mountPath, "/api/desktop-client")),
      requireAgentDesktop
    };

    response.type("application/javascript");
    response.send(`window.__ARK_WIDGET_CONFIG__ = ${JSON.stringify(config, null, 2)};`);
    logDebug("Served widget config", {
      ...buildRequestContext(request),
      mountPath,
      publicOrigin: publicOrigin || undefined,
      requireAgentDesktop
    });
  });

  router.get("/desktop.js", (_request, response) => {
    const configPath = joinMountPath(mountPath, "/config.js");
    const entryPath = joinMountPath(mountPath, "/app/main.js");

    response.type("application/javascript");
    response.send(buildDesktopBootstrapScript(configPath, entryPath, widgetAssetVersion));
  });

  router.get("/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();

    const client = {
      id: crypto.randomUUID(),
      response,
      agentId: null,
      agentAliases: [],
      taskIds: []
    };
    sseClients.add(client);
    logInfo("Desktop command stream connected", {
      ...buildRequestContext(request),
      clientId: client.id,
      connectedClients: sseClients.size
    });
    response.write("event: ready\n");
    response.write(`data: ${JSON.stringify({ ok: true, mountPath, clientId: client.id })}\n\n`);

    request.on("close", () => {
      sseClients.delete(client);
      logInfo("Desktop command stream disconnected", {
        ...buildRequestContext(request),
        clientId: client.id,
        connectedClients: sseClients.size
      });
    });
  });

  router.post("/api/desktop-client", (request, response) => {
    const { clientId, agentId = null, agentAliases = [], taskIds = [] } = request.body ?? {};

    if (typeof clientId !== "string" || !clientId) {
      logWarn("Desktop client registration rejected", {
        ...buildRequestContext(request),
        reason: "missing-client-id"
      });
      response.status(400).json({ error: "Client registration must include a string 'clientId'." });
      return;
    }

    const client = findClientById(sseClients, clientId);

    if (!client) {
      logWarn("Desktop client registration failed", {
        ...buildRequestContext(request),
        clientId,
        reason: "client-not-found"
      });
      response.status(404).json({ error: "Desktop client connection was not found." });
      return;
    }

    client.agentId = normalizeIdentityValue(agentId);
    client.agentAliases = normalizeIdentityList(agentAliases);
    client.taskIds = normalizeTaskIds(taskIds);

    logInfo("Desktop client registered", {
      ...buildRequestContext(request),
      clientId: client.id,
      agentId: client.agentId,
      agentAliases: client.agentAliases,
      taskIds: client.taskIds
    });

    response.json({
      ok: true,
      clientId: client.id,
      agentId: client.agentId,
      agentAliases: client.agentAliases,
      taskIds: client.taskIds
    });
  });

  router.post("/api/desktop-command", (request, response) => {
    if (requiresCommandAuth) {
      const commandAuthResult = validateCommandBasicAuth({
        request,
        expectedUsername: ariesCommandUsername,
        expectedPassword: ariesCommandPassword
      });

      if (!commandAuthResult.ok) {
        if (commandAuthResult.reason === "missing-command-auth-config") {
          logError("Desktop command auth misconfigured", {
            ...buildRequestContext(request),
            reason: commandAuthResult.reason
          });
          response.status(500).json({ error: "Inbound command authentication is misconfigured." });
          return;
        }

        logWarn("Desktop command rejected", {
          ...buildRequestContext(request),
          reason: commandAuthResult.reason
        });
        response.setHeader("WWW-Authenticate", "Basic realm=\"ark-widget-desktop-command\"");
        response.status(401).json({ error: "Unauthorized." });
        return;
      }
    }

    const command = request.body;

    if (!command || typeof command.type !== "string") {
      logWarn("Desktop command rejected", {
        ...buildRequestContext(request),
        reason: "missing-command-type"
      });
      response.status(400).json({ error: "Command payload must include a string 'type'." });
      return;
    }

    const targetClients = selectCommandTargets(sseClients, command);
    const connectedClientIdentities = Array.from(sseClients).map((client) => ({
      clientId: client.id,
      agentId: client.agentId,
      agentAliases: client.agentAliases,
      taskIds: client.taskIds
    }));

    logInfo("Desktop command routed", {
      ...buildRequestContext(request),
      commandType: command.type,
      connectedClients: sseClients.size,
      matchedClients: targetClients.length,
      targeting: getCommandTarget(command),
      connectedClientIdentities
    });
    broadcastEvent(targetClients, "desktop-command", command);
    response.status(202).json({
      accepted: true,
      connectedClients: sseClients.size,
      matchedClients: targetClients.length,
      targeting: getCommandTarget(command)
    });
  });

  router.post("/api/third-party/forward", async (request, response) => {
    const { endpoint = "/", method = "POST", body, headers = {}, useUploadApi = false } = request.body ?? {};

    if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
      logWarn("Aries forward rejected", {
        ...buildRequestContext(request),
        endpoint,
        reason: "invalid-endpoint"
      });
      response.status(400).json({ error: "'endpoint' must be a relative path starting with '/'" });
      return;
    }

    const trackedForwardContext = resolveTrackedCallAssociatedDataContext({
      body,
      trackedFieldDefinitions: trackedCallAssociatedDataFields,
      trackedState: trackedCallAssociatedDataState
    });
    const transformedBody = shouldTransformCallLifecyclePayload(endpoint, [
      ariesNewCallEndpoint,
      ariesRecordTransactionEndpoint
    ])
      ? buildAriesNewCallPayload({
        body: trackedForwardContext.forwardBody,
        trackedCallAssociatedData: trackedForwardContext.trackedCallAssociatedData,
        callLifecycleState
      })
      : trackedForwardContext.forwardBody;
    let finalForwardBody = transformedBody;

    if (useUploadApi) {
      try {
        finalForwardBody = await transcodeUploadPayloadToWav(transformedBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown audio transcoding error.";

        logError("Aries upload transcoding failed", {
          ...buildRequestContext(request),
          endpoint,
          method,
          error
        });
        response.status(502).json({ error: `Audio transcoding failed: ${message}` });
        return;
      }
    }

    const forwardRequest = {
      ...request.body,
      endpoint,
      method,
      headers,
      useUploadApi,
      body: finalForwardBody
    };

    logInfo("Aries forward payload received", {
      ...buildRequestContext(request),
      endpoint,
      method,
      useUploadApi,
      interactionId: trackedForwardContext.interactionId,
      trackedCallAssociatedData: trackedForwardContext.trackedCallAssociatedData,
      extractedTrackedCallAssociatedData: trackedForwardContext.extractedTrackedCallAssociatedData,
      body: sanitizeForwardBodyForLog(forwardRequest.body)
    });

    const destinationBaseUrl = useUploadApi && ariesUploadUrl
      ? ariesUploadUrl
      : ariesBaseUrl;

    if (!destinationBaseUrl) {
      const savedRecording = await maybePersistCapturedAudio({
        body: forwardRequest,
        recordingsDir,
        requestId: request.requestId
      });
      const savedCommandResult = await maybePersistCommandResult({
        body: forwardRequest,
        commandResultsDir,
        requestId: request.requestId
      });

      logWarn("Aries forward skipped", {
        ...buildRequestContext(request),
        endpoint,
        reason: useUploadApi ? "missing-aries-upload-url" : "missing-aries-base-url",
        savedRecordingPath: savedRecording?.audioFilePath ?? null,
        savedCommandResultPath: savedCommandResult?.filePath ?? null,
        interactionId: trackedForwardContext.interactionId,
        trackedCallAssociatedData: trackedForwardContext.trackedCallAssociatedData
      });
      response.status(202).json({
        mocked: true,
        message: useUploadApi
          ? "ARIES_API_UPLOAD_URL is not configured. Request was not forwarded."
          : "ARIES_API_BASE_URL is not configured. Request was not forwarded.",
        request: forwardRequest,
        savedRecording,
        savedCommandResult
      });
      return;
    }

    const url = resolveAriesUrl(destinationBaseUrl, endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ariesTimeoutMs);
    const startedAt = Date.now();

    logInfo("Forwarding request to Aries", {
      ...buildRequestContext(request),
      endpoint,
      method,
      timeoutMs: ariesTimeoutMs
    });

    try {
      const upstreamResponse = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(ariesApiKey ? { authorization: `Bearer ${ariesApiKey}` } : {}),
          ...headers
        },
        body: finalForwardBody === undefined ? undefined : JSON.stringify(finalForwardBody),
        signal: controller.signal
      });

      const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
      const responseText = await upstreamResponse.text();
      logInfo("Aries forward completed", {
        ...buildRequestContext(request),
        endpoint,
        method,
        upstreamStatus: upstreamResponse.status,
        durationMs: Date.now() - startedAt
      });
      response.status(upstreamResponse.status);
      response.type(contentType);
      response.send(responseText);
    } catch (error) {
      const message = error?.name === "AbortError"
        ? `Aries request timed out after ${ariesTimeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : "Unknown Aries forwarding error.";

      logError("Aries forward failed", {
        ...buildRequestContext(request),
        endpoint,
        method,
        durationMs: Date.now() - startedAt,
        error
      });

      response.status(502).json({ error: message });
    } finally {
      clearTimeout(timeout);
    }
  });

  router.get("*", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(mountPath, router);
  app.locals.arkWidgetMountPath = mountPath;
  return app;
}

export function joinMountPath(basePath, routePath) {
  if (!routePath || routePath === "/") {
    return normalizeMountPath(basePath);
  }

  const normalizedBasePath = normalizeMountPath(basePath);
  const normalizedRoutePath = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return normalizedBasePath === "/"
    ? normalizedRoutePath
    : `${normalizedBasePath}${normalizedRoutePath}`;
}

export function resolveAriesUrl(baseUrl, endpoint) {
  const resolvedBaseUrl = new URL(baseUrl);
  const resolvedEndpointUrl = new URL(endpoint, "https://ark-widget.invalid");

  resolvedBaseUrl.pathname = joinMountPath(resolvedBaseUrl.pathname, resolvedEndpointUrl.pathname);
  resolvedBaseUrl.search = resolvedEndpointUrl.search;
  resolvedBaseUrl.hash = resolvedEndpointUrl.hash;
  return resolvedBaseUrl;
}

function shouldTransformCallLifecyclePayload(endpoint, lifecycleEndpoints) {
  const normalizedEndpoint = normalizeOptionalString(endpoint);

  if (!normalizedEndpoint) {
    return false;
  }

  return lifecycleEndpoints
    .map((value) => normalizeOptionalString(value))
    .filter(Boolean)
    .includes(normalizedEndpoint);
}

function buildTrackedCallAssociatedDataFields({ consentRecordingFieldName, consentScriptPlayedFieldName }) {
  return [
    {
      outputKey: "consentRecordingComplete",
      fieldName: normalizeOptionalString(consentRecordingFieldName)
    },
    {
      outputKey: "consentScriptPlayed",
      fieldName: normalizeOptionalString(consentScriptPlayedFieldName)
    }
  ].filter((definition) => Boolean(definition.fieldName));
}

export function resolveTrackedCallAssociatedDataContext({ body, trackedFieldDefinitions, trackedState }) {
  if (!Array.isArray(trackedFieldDefinitions) || trackedFieldDefinitions.length === 0) {
    return {
      interactionId: resolveInteractionId(body),
      extractedTrackedCallAssociatedData: null,
      trackedCallAssociatedData: null,
      forwardBody: body
    };
  }

  const interactionId = resolveInteractionId(body);
  const extractedTrackedCallAssociatedData = extractTrackedCallAssociatedData(body, trackedFieldDefinitions);
  const trackedByInteraction = interactionId
    ? trackedState?.byInteractionId?.get?.(interactionId) ?? null
    : null;
  const mergedTrackedCallAssociatedData = mergeTrackedCallAssociatedData(
    trackedByInteraction,
    extractedTrackedCallAssociatedData
  );

  if (interactionId && hasTrackedCallAssociatedData(mergedTrackedCallAssociatedData)) {
    trackedState.byInteractionId.set(interactionId, mergedTrackedCallAssociatedData);
    trackedState.latestTrackedCallAssociatedData = {
      interactionId,
      values: mergedTrackedCallAssociatedData
    };
  } else if (hasTrackedCallAssociatedData(extractedTrackedCallAssociatedData)) {
    trackedState.latestTrackedCallAssociatedData = {
      interactionId,
      values: extractedTrackedCallAssociatedData
    };
  }

  const trackedCallAssociatedData = hasTrackedCallAssociatedData(mergedTrackedCallAssociatedData)
    ? mergedTrackedCallAssociatedData
    : interactionId
      ? trackedByInteraction
      : trackedState?.latestTrackedCallAssociatedData?.values ?? null;

  return {
    interactionId,
    extractedTrackedCallAssociatedData,
    trackedCallAssociatedData,
    forwardBody: attachTrackedCallAssociatedData(body, trackedCallAssociatedData)
  };
}

function extractTrackedCallAssociatedData(body, trackedFieldDefinitions) {
  const callAssociatedData = findFirstNestedObjectByNormalizedKey(body, "callassociateddata");

  if (!callAssociatedData) {
    return null;
  }

  const extracted = trackedFieldDefinitions.reduce((result, definition) => {
    const fieldValue = readCallAssociatedDataValue(callAssociatedData, definition.fieldName);

    if (fieldValue !== null) {
      result[definition.outputKey] = fieldValue;
    }

    return result;
  }, {});

  return Object.keys(extracted).length > 0 ? extracted : null;
}

function readCallAssociatedDataValue(callAssociatedData, fieldName) {
  if (!fieldName || !callAssociatedData || typeof callAssociatedData !== "object") {
    return null;
  }

  const value = callAssociatedData[fieldName];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return normalizeTrackedFieldValue(value.value);
  }

  return normalizeTrackedFieldValue(value);
}

function normalizeTrackedFieldValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "object") {
    return JSON.parse(JSON.stringify(value));
  }

  return value;
}

function mergeTrackedCallAssociatedData(existingValues, nextValues) {
  if (!hasTrackedCallAssociatedData(existingValues)) {
    return hasTrackedCallAssociatedData(nextValues) ? { ...nextValues } : null;
  }

  if (!hasTrackedCallAssociatedData(nextValues)) {
    return { ...existingValues };
  }

  return {
    ...existingValues,
    ...nextValues
  };
}

function hasTrackedCallAssociatedData(value) {
  return Boolean(value) && Object.keys(value).length > 0;
}

function attachTrackedCallAssociatedData(body, trackedCallAssociatedData) {
  if (!hasTrackedCallAssociatedData(trackedCallAssociatedData) || !body || typeof body !== "object") {
    return body;
  }

  return {
    ...body,
    trackedCallAssociatedData
  };
}

function buildAriesNewCallPayload({ body, trackedCallAssociatedData, callLifecycleState }) {
  const eventData = body?.payload?.data ?? {};
  const interaction = eventData?.interaction ?? {};
  const callProcessingDetails = interaction?.callProcessingDetails ?? {};
  const eventName = normalizeOptionalString(body?.eventName);
  const interactionId = normalizeOptionalString(interaction?.interactionId);
  const eventTime = eventData?.eventTime ?? null;
  const isStartEvent = eventName === "eAgentOfferContact";
  const isEndEvent = eventName === "eAgentContactEnded";
  const knownCallStartTime = interactionId
    ? callLifecycleState?.callStartTimeByInteractionId?.get?.(interactionId) ?? null
    : null;

  if (interactionId && isStartEvent && eventTime !== null) {
    callLifecycleState?.callStartTimeByInteractionId?.set?.(interactionId, eventTime);
  }

  return {
    transactionId: interactionId,
    userEmail: normalizeOptionalString(eventData?.agentEmailId),
    loginId: normalizeOptionalString(eventData?.agentId),
    loginName: normalizeOptionalString(eventData?.agentEmailId),
    callerPhnNum: normalizeOptionalString(callProcessingDetails?.ani),
    callStartTime: isStartEvent ? eventTime : knownCallStartTime,
    callEndTime: isEndEvent ? eventTime : null,
    consentRecComp: normalizeAriesFieldValue(trackedCallAssociatedData?.consentRecordingComplete),
    consentScrPlayedSw: normalizeAriesFieldValue(trackedCallAssociatedData?.consentScriptPlayed)
  };
}

function resolveInteractionId(body) {
  return pickFirstString([
    body?.interactionId,
    body?.payload?.interactionId,
    body?.payload?.data?.interactionId,
    body?.payload?.interaction?.interactionId,
    body?.payload?.data?.interaction?.interactionId,
    body?.metadata?.interactionId,
    body?.command?.payload?.interactionId,
    body?.command?.payload?.metadata?.interactionId,
    body?.result?.metadata?.interactionId,
    ...findNestedValuesByNormalizedKey(body, "interactionid")
  ]);
}

function sanitizeForwardBodyForLog(body) {
  return JSON.parse(JSON.stringify(body, (key, value) => {
    if (key === "base64" && typeof value === "string") {
      return `[base64 ${value.length} chars]`;
    }

    if (typeof value === "string" && value.length > 4000) {
      return `${value.slice(0, 4000)}...[${value.length - 4000} more chars]`;
    }

    return value;
  }));
}

function findNestedValuesByNormalizedKey(input, normalizedKey) {
  const matches = [];
  const seen = new WeakSet();

  walk(input, 0);
  return matches;

  function walk(value, depth) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (seen.has(value) || depth > 8) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1));
      return;
    }

    Object.entries(value).forEach(([key, currentValue]) => {
      if (normalizeKeyName(key) === normalizedKey) {
        const normalizedValue = normalizeOptionalString(currentValue);

        if (normalizedValue) {
          matches.push(normalizedValue);
        }
      }

      walk(currentValue, depth + 1);
    });
  }
}

function findFirstNestedObjectByNormalizedKey(input, normalizedKey) {
  const seen = new WeakSet();
  return walk(input, 0);

  function walk(value, depth) {
    if (!value || typeof value !== "object") {
      return null;
    }

    if (seen.has(value) || depth > 8) {
      return null;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const match = walk(item, depth + 1);

        if (match) {
          return match;
        }
      }

      return null;
    }

    for (const [key, currentValue] of Object.entries(value)) {
      if (normalizeKeyName(key) === normalizedKey && currentValue && typeof currentValue === "object") {
        return currentValue;
      }

      const nestedMatch = walk(currentValue, depth + 1);

      if (nestedMatch) {
        return nestedMatch;
      }
    }

    return null;
  }
}

function pickFirstString(values) {
  for (const value of values) {
    const normalizedValue = normalizeOptionalString(value);

    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return null;
}

function normalizeKeyName(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return String(value);
}

function validateCommandBasicAuth({ request, expectedUsername, expectedPassword }) {
  if (!expectedUsername || !expectedPassword) {
    return {
      ok: false,
      reason: "missing-command-auth-config"
    };
  }

  const headerValue = request.get("authorization");

  if (!headerValue || !headerValue.toLowerCase().startsWith("basic ")) {
    return {
      ok: false,
      reason: "missing-basic-auth"
    };
  }

  const encodedCredentials = headerValue.slice(6).trim();

  if (!encodedCredentials) {
    return {
      ok: false,
      reason: "missing-basic-auth"
    };
  }

  let decodedCredentials = null;

  try {
    decodedCredentials = Buffer.from(encodedCredentials, "base64").toString("utf8");
  } catch {
    return {
      ok: false,
      reason: "invalid-basic-auth"
    };
  }

  const separatorIndex = decodedCredentials.indexOf(":");

  if (separatorIndex < 0) {
    return {
      ok: false,
      reason: "invalid-basic-auth"
    };
  }

  const suppliedUsername = decodedCredentials.slice(0, separatorIndex);
  const suppliedPassword = decodedCredentials.slice(separatorIndex + 1);

  if (suppliedUsername !== expectedUsername || suppliedPassword !== expectedPassword) {
    return {
      ok: false,
      reason: "invalid-credentials"
    };
  }

  return {
    ok: true,
    reason: null
  };
}

function normalizeAriesFieldValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (trimmedValue === "") {
      return null;
    }

    if (trimmedValue.toLowerCase() === "true") {
      return true;
    }

    if (trimmedValue.toLowerCase() === "false") {
      return false;
    }

    return trimmedValue;
  }

  return value;
}

function normalizeMountPath(input) {
  if (!input || input === "/") {
    return "/";
  }

  const trimmed = input.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function broadcastEvent(clients, eventName, payload) {
  const serialized = JSON.stringify(payload);

  for (const client of clients) {
    client.response.write(`event: ${eventName}\n`);
    client.response.write(`data: ${serialized}\n\n`);
  }
}

function findClientById(clients, clientId) {
  for (const client of clients) {
    if (client.id === clientId) {
      return client;
    }
  }

  return null;
}

function normalizeIdentityValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return String(value);
}

function normalizeTaskIds(taskIds) {
  return normalizeIdentityList(taskIds);
}

function normalizeIdentityList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => normalizeIdentityValue(value))
        .filter(Boolean)
    )
  );
}

function getCommandTarget(command) {
  const target = command?.target ?? {};
  const agentId = normalizeIdentityValue(command?.agentId ?? target.agentId);
  const taskId = normalizeIdentityValue(command?.taskId ?? target.taskId);

  return {
    agentId,
    taskId
  };
}

function selectCommandTargets(clients, command) {
  const allClients = Array.from(clients);
  const target = getCommandTarget(command);

  if (!target.agentId && !target.taskId) {
    return allClients;
  }

  return allClients.filter((client) => {
    if (target.agentId && client.agentId === target.agentId) {
      return true;
    }

    if (target.agentId && client.agentAliases.includes(target.agentId)) {
      return true;
    }

    if (target.taskId && client.taskIds.includes(target.taskId)) {
      return true;
    }

    return false;
  });
}

function buildDesktopBootstrapScript(configPath, entryPath) {
  var versionQuery = new URLSearchParams({ v: arguments[2] || "" }).toString();
  var resolvedConfigPath = versionQuery ? `${configPath}?${versionQuery}` : configPath;
  var resolvedEntryPath = versionQuery ? `${entryPath}?${versionQuery}` : entryPath;
  return `(function bootstrapArkWidget() {
  var currentScript = document.currentScript;
  var scriptBaseUrl = currentScript && currentScript.src ? currentScript.src : window.location.href;
  var resolvedConfigUrl = new URL(${JSON.stringify(resolvedConfigPath)}, scriptBaseUrl).href;
  var resolvedEntryUrl = new URL(${JSON.stringify(resolvedEntryPath)}, scriptBaseUrl).href;
  var templateMarkup = ${JSON.stringify(`
  <style>
    :host {
      width: fit-content;
      max-width: 100%;
      display: inline-block;
      color: #102a43;
    }

    .shell {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      border: 1px solid rgba(16, 42, 67, 0.1);
      border-radius: 999px;
      overflow: hidden;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(240, 247, 252, 0.92));
      backdrop-filter: blur(14px);
      box-shadow: 0 14px 32px rgba(16, 42, 67, 0.12);
    }

    .hero {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      padding: 12px 14px 12px 18px;
      color: #102a43;
    }

    h1 {
      margin: 0;
      font-size: 15px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: 0.02em;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 11px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.01em;
      background: rgba(19, 118, 180, 0.12);
      color: #0f5f92;
      width: fit-content;
      max-width: 100%;
      white-space: nowrap;
    }

    .status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 0 3px rgba(15, 95, 146, 0.14);
    }

    @media (max-width: 520px) {
      .shell {
        display: flex;
        width: 100%;
        border-radius: 24px;
      }

      .hero {
        width: 100%;
        align-items: flex-start;
      }

      .status {
        white-space: normal;
      }
    }
  </style>
  <section class="shell">
    <div class="hero">
      <h1>Ark Desktop Bridge</h1>
      <div class="status" id="status">Initializing</div>
    </div>
  </section>
  `)};

  function formatData(value) {
    return JSON.stringify(value, null, 2);
  }

  function formatIdentifierList(values) {
    if (!Array.isArray(values) || values.length === 0) {
      return "Not available yet";
    }

    return values.join("\\n");
  }

  function getWidgetInstances() {
    return Array.from(document.querySelectorAll("sa-ds-sdk"));
  }

  function reportStatus(message) {
    getWidgetInstances().forEach(function updateInstance(widget) {
      if (typeof widget.updateStatus === "function") {
        widget.updateStatus(message);
      }
    });
  }

  function reportError(error, phase) {
    var message = error && error.message ? error.message : String(error);
    reportStatus(phase + ": " + message);

    getWidgetInstances().forEach(function updateInstance(widget) {
      if (typeof widget.showDesktopEvent === "function") {
        widget.showDesktopEvent({
          source: "desktop-bootstrap",
          type: "error",
          phase: phase,
          message: message
        });
      }
    });
  }

  function ensureRuntimeLoaded() {
    if (!window.__ARK_WIDGET_RUNTIME_PROMISE__) {
      reportStatus("Loading widget runtime");
      window.__ARK_WIDGET_RUNTIME_PROMISE__ = loadConfigScript()
        .then(function importEntrypoint() {
          reportStatus("Loading application module");
          return import(resolvedEntryUrl);
        })
        .then(function markRuntimeLoaded(moduleValue) {
          reportStatus("Widget runtime loaded");
          return moduleValue;
        })
        .catch(function handleRuntimeError(error) {
          reportError(error, "Runtime load failed");
          console.error("Failed to initialize Ark widget runtime.", error);
          throw error;
        });
    }

    return window.__ARK_WIDGET_RUNTIME_PROMISE__;
  }

  function loadConfigScript() {
    if (window.__ARK_WIDGET_CONFIG_PROMISE__) {
      return window.__ARK_WIDGET_CONFIG_PROMISE__;
    }

    reportStatus("Loading widget configuration");
    window.__ARK_WIDGET_CONFIG_PROMISE__ = new Promise(function resolveConfigScript(resolve, reject) {
      var existingScript = document.querySelector('script[data-ark-widget-config="true"]');

      if (existingScript) {
        if (window.__ARK_WIDGET_CONFIG_READY__) {
          resolve();
          return;
        }

        existingScript.addEventListener("load", function handleExistingLoad() {
          window.__ARK_WIDGET_CONFIG_READY__ = true;
          reportStatus("Widget configuration loaded");
          resolve();
        }, { once: true });
        existingScript.addEventListener("error", function handleExistingError() {
          reject(new Error("Failed to load Ark widget config script."));
        }, { once: true });
        return;
      }

      var configScript = document.createElement("script");
      configScript.src = resolvedConfigUrl;
      configScript.async = false;
      configScript.dataset.arkWidgetConfig = "true";
      configScript.onload = function handleConfigLoaded() {
        window.__ARK_WIDGET_CONFIG_READY__ = true;
        reportStatus("Widget configuration loaded");
        resolve();
      };
      configScript.onerror = function handleConfigError() {
        reject(new Error("Failed to load Ark widget config script."));
      };
      document.head.appendChild(configScript);
    });

    return window.__ARK_WIDGET_CONFIG_PROMISE__;
  }

  if (!customElements.get("sa-ds-sdk")) {
    class ArkDesktopWidget extends HTMLElement {
      constructor() {
        super();
        this.handleSync = null;
        this.handleSimulate = null;
        this.attachShadow({ mode: "open" });
        this.render();
      }

      connectedCallback() {
        this.bindControls();
        window.__ARK_WIDGET_ACTIVE_ELEMENT__ = this;
        this.updateStatus("Bootstrapping widget");
        if (typeof window.__ARK_WIDGET_ATTACH__ === "function") {
          window.__ARK_WIDGET_ATTACH__(this);
        }
        ensureRuntimeLoaded();
      }

      disconnectedCallback() {
        if (window.__ARK_WIDGET_ACTIVE_ELEMENT__ === this) {
          window.__ARK_WIDGET_ACTIVE_ELEMENT__ = undefined;
        }
      }

      render() {
        this.shadowRoot.innerHTML = templateMarkup;
        this.statusElement = this.shadowRoot.getElementById("status");
      }

      bindControls() {}

      setHandlers(handlers) {
        this.handleSync = handlers.onSync;
        this.handleSimulate = handlers.onSimulate;
      }

      updateStatus(message) {
        this.statusElement.textContent = message;
      }

      showDesktopEvent(event) {
        this.latestEventText = formatData(event);
      }

      showCommand(command) {
        this.latestCommandText = formatData(command);
      }

      showIdentifiers(_identifiers) {}
    }

    customElements.define("sa-ds-sdk", ArkDesktopWidget);
  }
})();\n`;
}

function getRequestOrigin(request) {
  const protocol = request.get("x-forwarded-proto") ?? request.protocol;
  const host = request.get("x-forwarded-host") ?? request.get("host");
  return `${protocol}://${host}`;
}

function toRuntimeUrl(origin, routePath) {
  if (!origin) {
    return routePath;
  }

  return new URL(routePath, `${origin}/`).href;
}

function normalizePublicOrigin(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\/$/, "");
}

async function maybePersistCapturedAudio({ body, recordingsDir, requestId }) {
  const capture = extractCapturePayload(body);

  if (!capture?.base64) {
    return null;
  }

  await fs.mkdir(recordingsDir, { recursive: true });

  const extension = pickAudioExtension(capture.mimeType, capture.fileName);
  const baseName = sanitizeFileStem(capture.fileName ?? `capture-${requestId ?? crypto.randomUUID()}`);
  const audioFileName = `${baseName}.${extension}`;
  const metadataFileName = `${baseName}.json`;
  const audioFilePath = path.join(recordingsDir, audioFileName);
  const metadataFilePath = path.join(recordingsDir, metadataFileName);

  await fs.writeFile(audioFilePath, Buffer.from(capture.base64, "base64"));
  await fs.writeFile(metadataFilePath, JSON.stringify({
    savedAt: new Date().toISOString(),
    endpoint: body?.endpoint ?? null,
    commandType: body?.body?.command?.type ?? null,
    metadata: capture.metadata ?? null,
    mimeType: capture.mimeType ?? null,
    sizeBytes: capture.sizeBytes ?? null,
    durationMs: capture.durationMs ?? null,
    source: capture.source ?? null,
    signal: capture.signal ?? null
  }, null, 2));

  logInfo("Captured audio persisted locally", {
    requestId,
    audioFilePath,
    metadataFilePath,
    mimeType: capture.mimeType ?? null,
    sizeBytes: capture.sizeBytes ?? null,
    durationMs: capture.durationMs ?? null
  });

  return {
    audioFilePath,
    metadataFilePath,
    mimeType: capture.mimeType ?? null,
    sizeBytes: capture.sizeBytes ?? null,
    durationMs: capture.durationMs ?? null
  };
}

function extractCapturePayload(forwardRequestBody) {
  const directDocBlob = forwardRequestBody?.body?.docBlob;

  if (typeof directDocBlob === "string" && directDocBlob.length > 0) {
    return {
      base64: directDocBlob,
      fileName: buildUploadedRecordingFileName(forwardRequestBody?.body),
      mimeType: inferUploadMimeType(forwardRequestBody?.body?.fileType),
      sizeBytes: null,
      durationMs: null,
      metadata: sanitizeUploadMetadata(forwardRequestBody?.body),
      source: null,
      signal: null
    };
  }

  const directAudio = forwardRequestBody?.body?.audio;

  if (directAudio?.base64) {
    return {
      base64: directAudio.base64,
      fileName: directAudio.fileName,
      mimeType: directAudio.mimeType,
      sizeBytes: directAudio.sizeBytes,
      durationMs: directAudio.durationMs,
      metadata: forwardRequestBody?.body?.metadata ?? null,
      source: forwardRequestBody?.body?.captureSource ?? forwardRequestBody?.body?.source ?? null,
      signal: forwardRequestBody?.body?.captureSignal ?? null
    };
  }

  const commandResult = forwardRequestBody?.body?.result;

  if (commandResult?.audioBase64) {
    return {
      base64: commandResult.audioBase64,
      fileName: commandResult.fileName,
      mimeType: commandResult.mimeType,
      sizeBytes: commandResult.sizeBytes,
      durationMs: commandResult.durationMs,
      metadata: commandResult.metadata ?? null,
      source: commandResult.source ?? null,
      signal: commandResult.signal ?? null
    };
  }

  return null;
}

async function transcodeUploadPayloadToWav(body) {
  if (!body || typeof body !== "object" || typeof body.docBlob !== "string" || body.docBlob.length === 0) {
    return body;
  }

  const inputBuffer = Buffer.from(body.docBlob, "base64");

  if (isWavBuffer(inputBuffer)) {
    return {
      ...body,
      fileType: "WAV"
    };
  }

  const wavBuffer = await transcodeAudioBufferToWav(inputBuffer);

  return {
    ...body,
    docBlob: wavBuffer.toString("base64"),
    fileType: "WAV"
  };
}

async function transcodeAudioBufferToWav(inputBuffer) {
  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1"
    ]);
    const stdoutChunks = [];
    const stderrChunks = [];

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`ffmpeg process failed to start: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }

      const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(new Error(stderrOutput || `ffmpeg exited with code ${code}`));
    });

    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(inputBuffer);
  });
}

function isWavBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WAVE";
}

function buildUploadedRecordingFileName(uploadBody) {
  const dialogId = normalizeOptionalString(uploadBody?.dialogId) ?? crypto.randomUUID();
  const fileType = normalizeOptionalString(uploadBody?.fileType)?.toLowerCase() ?? "wav";

  return `${sanitizeFileStem(dialogId)}.${fileType}`;
}

function inferUploadMimeType(fileType) {
  const normalizedFileType = normalizeOptionalString(fileType)?.toLowerCase();

  if (normalizedFileType === "wav") {
    return "audio/wav";
  }

  if (normalizedFileType === "mp3") {
    return "audio/mpeg";
  }

  return null;
}

function sanitizeUploadMetadata(uploadBody) {
  if (!uploadBody || typeof uploadBody !== "object") {
    return null;
  }

  const { docBlob, ...metadata } = uploadBody;
  return metadata;
}

function pickAudioExtension(mimeType, fileName) {
  const normalizedMimeType = String(mimeType ?? "").toLowerCase();

  if (fileName && /\.[a-z0-9]+$/i.test(fileName)) {
    return fileName.split(".").pop().toLowerCase();
  }

  if (normalizedMimeType.includes("ogg")) {
    return "ogg";
  }

  if (normalizedMimeType.includes("wav")) {
    return "wav";
  }

  if (normalizedMimeType.includes("mpeg") || normalizedMimeType.includes("mp3")) {
    return "mp3";
  }

  return "webm";
}

function sanitizeFileStem(fileName) {
  const stem = String(fileName ?? "capture")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return stem || "capture";
}

function isWidgetAssetRequest(requestPath) {
  return requestPath === "/desktop.js"
    || requestPath === "/config.js"
    || requestPath.startsWith("/app/");
}

async function maybePersistCommandResult({ body, commandResultsDir, requestId }) {
  if (body?.endpoint !== "/command-results" || body?.body === undefined) {
    return null;
  }

  await fs.mkdir(commandResultsDir, { recursive: true });

  const commandType = sanitizeFileStem(body?.body?.command?.type ?? "command-result");
  const fileName = `${commandType}-${requestId ?? crypto.randomUUID()}.json`;
  const filePath = path.join(commandResultsDir, fileName);

  await fs.writeFile(filePath, JSON.stringify(body.body, null, 2));

  logInfo("Command result persisted locally", {
    requestId,
    filePath,
    commandType: body?.body?.command?.type ?? null
  });

  return {
    filePath,
    commandType: body?.body?.command?.type ?? null
  };
}