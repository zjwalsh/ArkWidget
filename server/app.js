import express from "express";
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
  const ariesBaseUrl = options.ariesBaseUrl
    ?? process.env.ARIES_API_BASE_URL
    ?? "";
  const ariesApiKey = options.ariesApiKey
    ?? process.env.ARIES_API_KEY
    ?? "";
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
    const requestOrigin = getRequestOrigin(request);
    const config = {
      widgetName: options.widgetName ?? process.env.WIDGET_NAME ?? "ark-widget",
      widgetProvider: options.widgetProvider ?? process.env.WIDGET_PROVIDER ?? "ArkWidget",
      basePath: mountPath,
      assetVersion: widgetAssetVersion,
      sdkScriptPath: toAbsoluteUrl(requestOrigin, joinMountPath(mountPath, "/vendor/@wxcc-desktop/sdk/dist/index.js")),
      ariesForwardPath: toAbsoluteUrl(requestOrigin, joinMountPath(mountPath, "/api/third-party/forward")),
      ariesNewCallEndpoint,
      thirdPartyForwardPath: toAbsoluteUrl(requestOrigin, joinMountPath(mountPath, "/api/third-party/forward")),
      thirdPartyNewCallEndpoint: ariesNewCallEndpoint,
      commandStreamPath: toAbsoluteUrl(requestOrigin, joinMountPath(mountPath, "/events")),
      desktopRegistrationPath: toAbsoluteUrl(requestOrigin, joinMountPath(mountPath, "/api/desktop-client")),
      requireAgentDesktop
    };

    response.type("application/javascript");
    response.send(`window.__ARK_WIDGET_CONFIG__ = ${JSON.stringify(config, null, 2)};`);
    logDebug("Served widget config", {
      ...buildRequestContext(request),
      mountPath,
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
    if (!ariesBaseUrl) {
      const savedRecording = await maybePersistCapturedAudio({
        body: request.body,
        recordingsDir,
        requestId: request.requestId
      });
      const savedCommandResult = await maybePersistCommandResult({
        body: request.body,
        commandResultsDir,
        requestId: request.requestId
      });

      logWarn("Aries forward skipped", {
        ...buildRequestContext(request),
        endpoint: request.body?.endpoint ?? null,
        reason: "missing-aries-base-url",
        savedRecordingPath: savedRecording?.audioFilePath ?? null,
        savedCommandResultPath: savedCommandResult?.filePath ?? null
      });
      response.status(202).json({
        mocked: true,
        message: "ARIES_API_BASE_URL is not configured. Request was not forwarded.",
        request: request.body ?? null,
        savedRecording,
        savedCommandResult
      });
      return;
    }

    const { endpoint = "/", method = "POST", body, headers = {} } = request.body ?? {};

    if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
      logWarn("Aries forward rejected", {
        ...buildRequestContext(request),
        endpoint,
        reason: "invalid-endpoint"
      });
      response.status(400).json({ error: "'endpoint' must be a relative path starting with '/'" });
      return;
    }

    const url = new URL(endpoint, ariesBaseUrl);
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
        body: body === undefined ? undefined : JSON.stringify(body),
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
      width: min(100%, 960px);
      display: block;
      color: #102a43;
    }

    .shell {
      border: 1px solid rgba(16, 42, 67, 0.08);
      border-radius: 28px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.82);
      backdrop-filter: blur(18px);
      box-shadow: 0 24px 60px rgba(16, 42, 67, 0.14);
    }

    .hero {
      padding: 24px;
      background:
        linear-gradient(135deg, rgba(16, 42, 67, 0.96), rgba(19, 118, 180, 0.92)),
        linear-gradient(45deg, #102a43, #1376b4);
      color: white;
    }

    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      opacity: 0.72;
      margin-bottom: 10px;
    }

    h1 {
      margin: 0;
      font-size: clamp(28px, 5vw, 42px);
      line-height: 1;
      font-weight: 700;
    }

    .hero p {
      margin: 12px 0 0;
      max-width: 60ch;
      color: rgba(255, 255, 255, 0.86);
    }

    .content {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      padding: 20px;
    }

    .panel {
      border-radius: 20px;
      padding: 18px;
      background: linear-gradient(180deg, rgba(250, 251, 252, 0.95), rgba(239, 244, 248, 0.9));
      border: 1px solid rgba(19, 118, 180, 0.12);
      min-height: 200px;
    }

    .panel h2 {
      margin: 0 0 12px;
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #486581;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      background: rgba(239, 164, 45, 0.18);
      color: #8d5d00;
    }

    .status::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }

    pre {
      margin: 0;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #243b53;
    }

    button {
      border: 0;
      border-radius: 14px;
      background: #102a43;
      color: white;
      font: inherit;
      padding: 10px 14px;
      cursor: pointer;
    }

    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 16px;
    }

    .identifier-grid {
      display: grid;
      gap: 12px;
    }

    .identifier-row {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(16, 42, 67, 0.04);
      border: 1px solid rgba(16, 42, 67, 0.08);
    }

    .identifier-label {
      display: block;
      margin-bottom: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #486581;
    }

    .identifier-value {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: #102a43;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
  <section class="shell">
    <div class="hero">
      <div class="eyebrow">Cisco Webex Contact Center</div>
      <h1>Ark Desktop Bridge</h1>
      <p>Consumes Agent Desktop state, relays data to your third-party service, and executes commands returned into the WXCC SDK.</p>
    </div>
    <div class="content">
      <article class="panel">
        <h2>Connection</h2>
        <div class="status" id="status">Initializing</div>
        <div class="actions">
          <button id="sync">Send Snapshot</button>
          <button id="simulate">Simulate Notification</button>
        </div>
      </article>
      <article class="panel">
        <h2>Latest Desktop Event</h2>
        <pre id="event">Waiting for Agent Desktop data...</pre>
      </article>
      <article class="panel">
        <h2>Latest Command</h2>
        <pre id="command">Waiting for third-party commands...</pre>
      </article>
      <article class="panel">
        <h2>Live Identifiers</h2>
        <div class="identifier-grid">
          <div class="identifier-row">
            <span class="identifier-label">Agent ID</span>
            <pre class="identifier-value" id="agent-id">Waiting for live events...</pre>
          </div>
          <div class="identifier-row">
            <span class="identifier-label">Task IDs</span>
            <pre class="identifier-value" id="task-ids">Waiting for live events...</pre>
          </div>
          <div class="identifier-row">
            <span class="identifier-label">Interaction IDs</span>
            <pre class="identifier-value" id="interaction-ids">Waiting for live events...</pre>
          </div>
        </div>
      </article>
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
        this.eventElement = this.shadowRoot.getElementById("event");
        this.commandElement = this.shadowRoot.getElementById("command");
        this.agentIdElement = this.shadowRoot.getElementById("agent-id");
        this.taskIdsElement = this.shadowRoot.getElementById("task-ids");
        this.interactionIdsElement = this.shadowRoot.getElementById("interaction-ids");
        this.syncButton = this.shadowRoot.getElementById("sync");
        this.simulateButton = this.shadowRoot.getElementById("simulate");
      }

      bindControls() {
        this.syncButton.onclick = () => this.handleSync && this.handleSync();
        this.simulateButton.onclick = () => this.handleSimulate && this.handleSimulate();
      }

      setHandlers(handlers) {
        this.handleSync = handlers.onSync;
        this.handleSimulate = handlers.onSimulate;
      }

      updateStatus(message) {
        this.statusElement.textContent = message;
      }

      showDesktopEvent(event) {
        this.eventElement.textContent = formatData(event);
      }

      showCommand(command) {
        this.commandElement.textContent = formatData(command);
      }

      showIdentifiers(identifiers) {
        this.agentIdElement.textContent = identifiers && identifiers.agentId ? identifiers.agentId : "Not available yet";
        this.taskIdsElement.textContent = formatIdentifierList(identifiers && identifiers.taskIds);
        this.interactionIdsElement.textContent = formatIdentifierList(identifiers && identifiers.interactionIds);
      }
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

function toAbsoluteUrl(origin, routePath) {
  return new URL(routePath, `${origin}/`).href;
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