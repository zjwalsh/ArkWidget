import { getWidgetConfig } from "./config.js";
import { ArkWxccWidget } from "./components/ark-wxcc-widget.js";
import { WxccClient } from "./services/wxcc-client.js";
import { AgentStoreBridge } from "./services/agent-store-bridge.js";
import { AriesApiClient } from "./services/third-party-api.js";
import { CommandStream } from "./services/command-stream.js";

const config = getWidgetConfig();
const wxccClient = new WxccClient(config);
const storeBridge = new AgentStoreBridge(wxccClient);
const ariesApi = new AriesApiClient(config);
const commandStream = new CommandStream(config);
const runtimeViewState = {
  status: "Bootstrapping widget",
  latestEvent: null,
  latestCommand: null,
  latestIdentifiers: null,
  handlers: null
};
const desktopRoutingState = {
  connectedClientId: null,
  registrationKey: null,
  skippedIdentityKey: null
};

window.__ARK_WIDGET_ATTACH__ = (attachedWidget) => {
  syncWidget(attachedWidget);
};

const widget = getWidget();

if (!widget) {
  throw new Error("Ark widget host element was not found.");
}

syncWidget(widget);

bootstrap().catch((error) => {
  updateStatus("Initialization failed");
  showDesktopEvent({ error: error.message });
  console.error(error);
});

async function bootstrap() {
  updateStatus("Initializing WXCC SDK");
  await wxccClient.init();
  updateStatus("Connected to Agent Desktop");

  storeBridge.start(async (event) => {
    showDesktopEvent(event);

    try {
      await syncDesktopRouting(event);
    } catch (error) {
      showCommand({ registrationError: error.message });
    }

    if (isNewCallEvent(event)) {
      try {
        await handleNewCallArrival(event);
      } catch (error) {
        showCommand({ newCallWebhookError: error.message });
      }
    }

    try {
      await ariesApi.sendAgentEvent(event);
      updateStatus("Agent Desktop data forwarding active");
    } catch (error) {
      updateStatus("Forwarding failed");
      showCommand({ forwardingError: error.message });
    }
  });

  commandStream.connect({
    onReady: async (payload) => {
      desktopRoutingState.connectedClientId = payload?.clientId ?? null;

      if (runtimeViewState.latestEvent) {
        try {
          await syncDesktopRouting(runtimeViewState.latestEvent);
        } catch (error) {
          showCommand({ registrationError: error.message });
        }
      }
    },
    onStatus: (message) => updateStatus(message),
    onCommand: async (command) => {
      const resolvedCommand = enrichCommandWithCurrentInteraction(command);
      showCommand(resolvedCommand);

      try {
        const result = await wxccClient.executeCommand(resolvedCommand);
        showCommand({
          command: resolvedCommand,
          result: summarizeCommandResultForDisplay(resolvedCommand, result)
        });

        if (
          (resolvedCommand?.type === "captureAudioSnippet" || resolvedCommand?.type === "stopAudioCapture")
          && resolvedCommand?.payload?.delivery
        ) {
          const deliveryResponse = await ariesApi.sendCapturedAudio(resolvedCommand, result);
          showCommand({
            command: resolvedCommand,
            result: {
              delivered: true,
              endpoint: resolvedCommand.payload.delivery.endpoint ?? "/telephonic-signatures",
              capture: summarizeCommandResultForDisplay(resolvedCommand, result),
              deliveryResponse
            }
          });
          await ariesApi.sendCommandResult(resolvedCommand, {
            delivered: true,
            endpoint: resolvedCommand.payload.delivery.endpoint ?? "/telephonic-signatures",
            capture: {
              fileName: result?.fileName ?? null,
              mimeType: result?.mimeType ?? null,
              sizeBytes: result?.sizeBytes ?? null,
              durationMs: result?.durationMs ?? null,
              metadata: result?.metadata ?? null
            },
            deliveryResponse
          });
          return;
        }

        await ariesApi.sendCommandResult(resolvedCommand, result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await ariesApi.sendCommandResult(resolvedCommand, null, errorMessage);
        showCommand({ command: resolvedCommand, error: errorMessage });
        updateStatus(`Command execution failed: ${errorMessage}`);
      }
    }
  });

  runtimeViewState.handlers = {
    onSync: async () => {
      const snapshot = {
        source: "manual",
        type: "snapshot",
        payload: wxccClient.getAgentSnapshot()
      };
      showDesktopEvent(snapshot);
      await ariesApi.sendAgentEvent(snapshot);
      updateStatus("Manual snapshot forwarded");
    },
    onSimulate: async () => {
      const command = {
        type: "notification",
        payload: {
          title: "Ark Widget",
          message: "Simulation path is wired correctly.",
          mode: "acknowledge"
        }
      };
      showCommand(command);
      const result = await wxccClient.executeCommand(command);
      await ariesApi.sendCommandResult(command, result);
    }
  };

  syncWidget(getWidget());
}

window.addEventListener("beforeunload", () => {
  storeBridge.stop();
  commandStream.disconnect();
});

function getWidget() {
  return window.__ARK_WIDGET_ACTIVE_ELEMENT__ ?? document.querySelector("ark-wxcc-widget, sa-ds-sdk");
}

function syncWidget(attachedWidget) {
  if (!attachedWidget) {
    return;
  }

  attachedWidget.updateStatus(runtimeViewState.status);

  if (runtimeViewState.latestEvent !== null) {
    attachedWidget.showDesktopEvent(runtimeViewState.latestEvent);
  }

  if (runtimeViewState.latestCommand !== null) {
    attachedWidget.showCommand(runtimeViewState.latestCommand);
  }

  if (runtimeViewState.latestIdentifiers !== null) {
    attachedWidget.showIdentifiers(runtimeViewState.latestIdentifiers);
  }

  if (runtimeViewState.handlers) {
    attachedWidget.setHandlers(runtimeViewState.handlers);
  }
}

function updateStatus(message) {
  runtimeViewState.status = message;
  getWidget()?.updateStatus(message);
}

function showDesktopEvent(event) {
  runtimeViewState.latestEvent = event;
  getWidget()?.showDesktopEvent(event);
  updateLiveIdentifiers(event);
}

function showCommand(command) {
  runtimeViewState.latestCommand = command;
  getWidget()?.showCommand(command);
}

function showIdentifiers(identifiers) {
  runtimeViewState.latestIdentifiers = identifiers;
  getWidget()?.showIdentifiers(identifiers);
}

async function syncDesktopRouting(event) {
  if (!desktopRoutingState.connectedClientId) {
    return;
  }

  const identity = extractDesktopIdentity(event);

  if (!identity.agentId && identity.agentAliases.length === 0 && identity.taskIds.length === 0) {
    const skippedIdentityKey = JSON.stringify({
      source: event?.source ?? null,
      type: event?.type ?? null,
      eventName: event?.eventName ?? null,
      identity
    });

    if (skippedIdentityKey !== desktopRoutingState.skippedIdentityKey) {
      desktopRoutingState.skippedIdentityKey = skippedIdentityKey;
      console.info("[ark-widget] desktop registration skipped", {
        clientId: desktopRoutingState.connectedClientId,
        source: event?.source ?? null,
        type: event?.type ?? null,
        eventName: event?.eventName ?? null,
        identity
      });
    }

    return;
  }

  const registrationKey = JSON.stringify(identity);

  if (registrationKey === desktopRoutingState.registrationKey) {
    return;
  }

  console.info("[ark-widget] registering desktop client", {
    clientId: desktopRoutingState.connectedClientId,
    identity
  });
  await commandStream.registerClient(identity);
  desktopRoutingState.registrationKey = registrationKey;
  desktopRoutingState.skippedIdentityKey = null;
}

async function handleNewCallArrival(event) {
  await ariesApi.sendNewCallEvent({
    ...event,
    detectedAt: new Date().toISOString()
  });
}

function isNewCallEvent(event) {
  if (event?.source !== "sdk" || event?.type !== "agent-contact") {
    return false;
  }

  if (event.eventName !== "eAgentOfferContact") {
    return false;
  }

  const mediaType = [
    event.payload?.mediaType,
    event.payload?.channelType,
    event.payload?.interaction?.mediaType,
    event.payload?.interaction?.channelType,
    event.payload?.data?.mediaType,
    event.payload?.data?.channelType
  ].find((value) => value !== undefined && value !== null);

  if (!mediaType) {
    return true;
  }

  return ["telephony", "call"].includes(String(mediaType).toLowerCase());
}

function extractDesktopIdentity(event) {
  const payload = event?.payload ?? {};
  const storeState = safelyGetStoreState();
  const agentSnapshot = wxccClient.getAgentSnapshot();
  const identitySources = [payload, storeState, agentSnapshot];
  const agentId = pickFirstString(identitySources.map((source) => extractPrimaryAgentId(source)));

  return {
    agentId,
    agentAliases: collectAgentAliases(identitySources, agentId),
    taskIds: mergeIdentifierLists(identitySources.map((source) => collectTaskIds(source))),
    interactionIds: mergeIdentifierLists(identitySources.map((source) => collectInteractionIds(source)))
  };
}

function safelyGetStoreState() {
  try {
    return window.$Store?.getState?.() ?? null;
  } catch {
    return null;
  }
}

function extractPrimaryAgentId(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  return pickFirstString([
    source?.agentSession?.agentId,
    source?.agentSession?.agentInfo?.agentId,
    source?.agentSession?.data?.agentId,
    source?.agentProfile?.agentId,
    source?.agentProfile?.id,
    source?.agentState?.agentId,
    source?.agentState?.latestData?.agentId,
    source?.data?.agentId,
    ...findNestedValuesByKey(source, "agentid")
  ]);
}

function collectAgentAliases(sources, primaryAgentId) {
  const aliases = new Set();

  sources.forEach((source) => {
    if (!source || typeof source !== "object") {
      return;
    }

    [
      source?.agentSession?.agentProfileID,
      source?.agentSession?.agentProfileId,
      source?.agentProfile?.agentProfileID,
      source?.agentProfile?.agentProfileId,
      source?.agentState?.agentProfileID,
      source?.agentState?.agentProfileId,
      source?.agentState?.latestData?.agentProfileID,
      source?.agentState?.latestData?.agentProfileId,
      source?.data?.agentProfileID,
      source?.data?.agentProfileId,
      source?.agentSession?.agentSessionId,
      source?.agentProfile?.agentSessionId,
      source?.agentState?.agentSessionId,
      source?.agentState?.latestData?.agentSessionId,
      source?.data?.agentSessionId,
      ...findNestedValuesByKey(source, "agentprofileid"),
      ...findNestedValuesByKey(source, "agentsessionid")
    ].forEach((value) => {
      const normalizedValue = normalizeIdentifier(value);

      if (!normalizedValue || normalizedValue === primaryAgentId) {
        return;
      }

      aliases.add(normalizedValue);
    });
  });

  return Array.from(aliases);
}

function collectTaskIds(payload) {
  const taskIds = new Set();

  addValue(taskIds, payload?.agentContact?.taskId);
  addValue(taskIds, payload?.agentContact?.data?.taskId);
  addValue(taskIds, payload?.agentContact?.contactData?.taskId);
  addValue(taskIds, payload?.taskId);
  addValue(taskIds, payload?.data?.taskId);

  if (payload?.taskMap && typeof payload.taskMap === "object") {
    Object.entries(payload.taskMap).forEach(([taskId, taskValue]) => {
      addValue(taskIds, taskId);
      addValue(taskIds, taskValue?.taskId);
      addValue(taskIds, taskValue?.data?.taskId);
    });
  }

  return Array.from(taskIds);
}

function collectInteractionIds(payload) {
  const interactionIds = new Set();

  addValue(interactionIds, payload?.interactionId);
  addValue(interactionIds, payload?.data?.interactionId);
  addValue(interactionIds, payload?.interaction?.interactionId);
  addValue(interactionIds, payload?.agentContact?.interactionId);
  addValue(interactionIds, payload?.agentContact?.data?.interactionId);
  addValue(interactionIds, payload?.agentContact?.contactData?.interactionId);

  if (payload?.taskMap && typeof payload.taskMap === "object") {
    Object.values(payload.taskMap).forEach((taskValue) => {
      addValue(interactionIds, taskValue?.interactionId);
      addValue(interactionIds, taskValue?.data?.interactionId);
      addValue(interactionIds, taskValue?.contactData?.interactionId);
    });
  }

  return Array.from(interactionIds);
}

function addValue(target, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  target.add(String(value));
}

function pickFirstString(values) {
  for (const value of values) {
    const normalizedValue = normalizeIdentifier(value);

    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return null;
}

function normalizeIdentifier(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return String(value);
}

function mergeIdentifierLists(lists) {
  return Array.from(
    new Set(
      lists.flatMap((list) => Array.isArray(list) ? list : [])
    )
  );
}

function findNestedValuesByKey(input, normalizedKey) {
  const matches = [];
  const seen = new WeakSet();

  walkObject(input, 0);
  return matches;

  function walkObject(value, depth) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (seen.has(value) || depth > 8) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => walkObject(item, depth + 1));
      return;
    }

    Object.entries(value).forEach(([key, currentValue]) => {
      if (normalizeKeyName(key) === normalizedKey) {
        const normalizedValue = normalizeIdentifier(currentValue);

        if (normalizedValue) {
          matches.push(normalizedValue);
        }
      }

      walkObject(currentValue, depth + 1);
    });
  }
}

function normalizeKeyName(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function updateLiveIdentifiers(event) {
  const identifiers = extractDesktopIdentity(event);
  showIdentifiers(identifiers);
  console.info("[ark-widget] live identifiers", identifiers);
}

function enrichCommandWithCurrentInteraction(command) {
  if (!shouldInjectInteractionId(command)) {
    return command;
  }

  const currentInteractionId = resolveCurrentInteractionId();

  if (!currentInteractionId) {
    return command;
  }

  const payload = isPlainObject(command?.payload) ? command.payload : {};
  const metadata = isPlainObject(payload.metadata) ? payload.metadata : {};

  if (metadata.interactionId || payload.interactionId) {
    return command;
  }

  return {
    ...command,
    payload: {
      ...payload,
      interactionId: currentInteractionId,
      metadata: {
        ...metadata,
        interactionId: currentInteractionId
      }
    }
  };
}

function shouldInjectInteractionId(command) {
  return [
    "captureAudioSnippet",
    "startAudioCapture",
    "stopAudioCapture"
  ].includes(command?.type);
}

function resolveCurrentInteractionId() {
  const storeState = safelyGetStoreState();
  const storeInteractionId = pickFirstString([
    storeState?.agentContact?.interactionId,
    storeState?.agentContact?.data?.interactionId,
    storeState?.agentContact?.contactData?.interactionId
  ]);

  if (storeInteractionId) {
    return storeInteractionId;
  }

  return pickFirstString([
    runtimeViewState.latestIdentifiers?.interactionIds?.[0],
    ...collectInteractionIds(runtimeViewState.latestEvent?.payload ?? {})
  ]);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeCommandResultForDisplay(command, result) {
  if (command?.type === "inspectMediaCapture") {
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    const recordableCandidates = Array.isArray(result?.recordableCandidates) ? result.recordableCandidates : [];

    return {
      supported: result?.supported ?? null,
      candidateCount: candidates.length,
      recordableCandidateCount: recordableCandidates.length,
      recordableCandidates,
      candidatePreview: candidates.slice(0, 5),
      truncated: candidates.length > 5
        ? `${candidates.length - 5} additional media candidates omitted from gadget view.`
        : null
    };
  }

  if (!result || typeof result !== "object") {
    return limitDisplayText(result);
  }

  if (["captureAudioSnippet", "stopAudioCapture"].includes(command?.type)) {
    const { audioBase64, ...rest } = result;
    return {
      ...rest,
      audioBase64: audioBase64 ? `[base64 ${audioBase64.length} chars]` : null
    };
  }

  return limitObjectForDisplay(result);
}

function limitObjectForDisplay(value) {
  const serialized = safeSerializeForDisplay(value);

  if (serialized.length <= 4000) {
    return value;
  }

  return {
    preview: serialized.slice(0, 4000),
    truncated: `${serialized.length - 4000} additional characters omitted from gadget view.`
  };
}

function limitDisplayText(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= 4000) {
    return value;
  }

  return `${value.slice(0, 4000)}\n...[${value.length - 4000} more characters omitted from gadget view]`;
}

function safeSerializeForDisplay(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }, null, 2);
  }
}

export { ArkWxccWidget };
