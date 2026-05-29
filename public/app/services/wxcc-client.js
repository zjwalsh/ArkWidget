import { MediaCaptureService } from "./media-capture.js";

export class WxccClient {
  constructor(config) {
    this.config = config;
    this.logger = console;
    this.initialized = false;
    this.desktop = null;
    this.cachedProfile = null;
    this.runtimeMode = "agent-desktop";
    this.mediaCapture = new MediaCaptureService();
  }

  async init() {
    if (this.initialized) {
      return;
    }

    if (!window.AGENTX_SERVICE) {
      throw new Error("Agent Desktop runtime is required but AGENTX_SERVICE is not available.");
    }

    await loadWxccDesktopSdk();
    this.desktop = window.WxccDesktopSDK?.Desktop;

    if (!this.desktop) {
      throw new Error("WXCC SDK could not be initialized.");
    }

    this.desktop.config.init({
      widgetName: this.config.widgetName,
      widgetProvider: this.config.widgetProvider
    });

    this.cachedProfile = await this.loadRuntimeProfile();

    this.logger = this.desktop.logger.createLogger(this.config.widgetName);
    this.initialized = true;
    this.logger.info("WXCC client initialized in agent-desktop mode");
  }

  getAgentSnapshot() {
    return {
      agentState: this.desktop.agentStateInfo.latestData ?? null,
      serviceProfile: window.AGENTX_SERVICE?.conf?.profile ?? null,
      fetchedProfile: this.cachedProfile,
      serviceFlags: {
        hasProfile: Boolean(window.AGENTX_SERVICE?.conf?.profile),
        hasFetchProfile: typeof window.AGENTX_SERVICE?.conf?.fetchProfile === "function"
      },
      runtimeMode: this.runtimeMode
    };
  }

  subscribeToDesktopEvents(listener) {
    const stateListener = (updates) => {
      listener({ source: "sdk", type: "agent-state-updated", payload: updates });
    };
    const outdialFailedListener = (message) => {
      listener({ source: "sdk", type: "dialer-event", eventName: "eOutdialFailed", payload: message });
    };

    const offerContactListener = createContactListener(listener, "eAgentOfferContact");
    const activeContactListener = createContactListener(listener, "eAgentContact");
    const contactEndedListener = createContactListener(listener, "eAgentContactEnded");

    this.desktop.agentStateInfo.addEventListener("updated", stateListener);
    this.desktop.dialer?.addEventListener?.("eOutdialFailed", outdialFailedListener);
    this.desktop.agentContact.addEventListener("eAgentContact", activeContactListener);
    this.desktop.agentContact.addEventListener("eAgentOfferContact", offerContactListener);
    this.desktop.agentContact.addEventListener("eAgentContactEnded", contactEndedListener);

    return () => {
      this.desktop.agentStateInfo.removeEventListener("updated", stateListener);
      this.desktop.dialer?.removeEventListener?.("eOutdialFailed", outdialFailedListener);
      this.desktop.agentContact.removeEventListener("eAgentContact", activeContactListener);
      this.desktop.agentContact.removeEventListener("eAgentOfferContact", offerContactListener);
      this.desktop.agentContact.removeEventListener("eAgentContactEnded", contactEndedListener);
    };
  }

  async executeCommand(command) {
    const payload = command?.payload ?? {};

    switch (command?.type) {
      case "notification":
        return this.fireNotification(payload);
      case "stateChange":
        return this.changeAgentState(payload);
      case "startOutdial":
      case "outdial":
        return this.startOutdial(payload);
      case "conference":
        return this.startConference(payload);
      case "updateCadVariables":
        return this.updateCadVariables(payload);
      case "inspectMediaCapture":
        return this.inspectMediaCapture();
      case "captureAudioSnippet":
        return this.captureAudioSnippet(payload);
      case "startAudioCapture":
        return this.startAudioCapture(payload);
      case "stopAudioCapture":
        return this.stopAudioCapture(payload);
      case "confirmAudioCapture":
        return this.confirmAudioCapture(payload);
      case "cancelAudioCapture":
        return this.cancelAudioCapture();
      case "getAudioCaptureStatus":
        return this.getAudioCaptureStatus();
      case "hold":
        return this.desktop.agentContact.hold(payload);
      case "unhold":
        return this.desktop.agentContact.unHold(payload);
      case "endContact":
        return this.endContact(payload);
      case "sendDtmf":
        return this.desktop.agentContact.sendDtmf(payload.digit);
      default:
        throw new Error(`Unsupported command type: ${command?.type}`);
    }
  }

  async fireNotification(payload) {
    const notification = {
      title: payload.title ?? "Ark Widget",
      message: payload.message ?? "Notification received",
      ...payload
    };

    if (payload.mode === "acknowledge") {
      return this.desktop.actions.fireGeneralAcknowledgeNotification(notification);
    }

    if (payload.mode === "auto-dismiss") {
      return this.desktop.actions.fireGeneralAutoDismissNotification(notification);
    }

    return this.desktop.actions.fireGeneralSilentNotification(notification);
  }

  async changeAgentState(payload) {
    if (typeof this.desktop.agentStateInfo.stateChangeV2 === "function") {
      return this.desktop.agentStateInfo.stateChangeV2(payload);
    }

    return this.desktop.agentStateInfo.stateChange(payload);
  }

  async startOutdial(payload) {
    const latestAgentState = this.desktop.agentStateInfo.latestData ?? {};
    const dialerTask = payload?.data ?? {};

    if (latestAgentState.isOutboundEnabledForTenant === false) {
      throw new Error("Outbound calling is disabled for the tenant.");
    }

    if (latestAgentState.isOutboundEnabledForAgent === false) {
      throw new Error("Outbound calling is disabled for the current agent.");
    }

    if (latestAgentState.isAdhocDialingEnabled === false) {
      throw new Error("Ad hoc outbound dialing is disabled for the current agent.");
    }

    if (!this.desktop.dialer?.startOutdial) {
      throw new Error("WXCC dialer.startOutdial is not available in this runtime.");
    }

    if (!dialerTask.entryPointId) {
      throw new Error("Outdial payload must include payload.data.entryPointId.");
    }

    if (!isUuid(dialerTask.entryPointId)) {
      throw new Error("Outdial payload payload.data.entryPointId must be a valid UUID.");
    }

    if (!dialerTask.destination) {
      throw new Error("Outdial payload must include payload.data.destination.");
    }

    if (!dialerTask.direction) {
      throw new Error("Outdial payload must include payload.data.direction (UUID required by WXCC dialer).");
    }

    if (!isUuid(dialerTask.direction)) {
      throw new Error("Outdial payload payload.data.direction must be a valid UUID from your WXCC tenant.");
    }

    if (dialerTask.origin === "AGENT_DN") {
      throw new Error("Outdial payload payload.data.origin must be the real agent DN, not the literal placeholder 'AGENT_DN'.");
    }

    if (!dialerTask.attributes || typeof dialerTask.attributes !== "object") {
      throw new Error("Outdial payload must include payload.data.attributes with key and value.");
    }

    if (!dialerTask.attributes.key || !dialerTask.attributes.value) {
      throw new Error("Outdial payload must include payload.data.attributes.key and payload.data.attributes.value.");
    }

    return this.desktop.dialer.startOutdial(payload);
  }

  async startConference(payload) {
    if (typeof this.desktop.agentContact.consultConferenceV2 === "function") {
      return this.desktop.agentContact.consultConferenceV2(payload);
    }

    return this.desktop.agentContact.consultConference(payload);
  }

  async updateCadVariables(payload) {
    if (typeof this.desktop.dialer?.updateCadVariables !== "function") {
      throw new Error("WXCC dialer.updateCadVariables is not available in this runtime.");
    }

    return this.desktop.dialer.updateCadVariables(payload);
  }

  async inspectMediaCapture() {
    return this.mediaCapture.inspectAvailableSources();
  }

  async captureAudioSnippet(payload) {
    return this.mediaCapture.captureSnippet(payload);
  }

  async startAudioCapture(payload) {
    return this.mediaCapture.startCapture(payload);
  }

  async stopAudioCapture(payload) {
    return this.mediaCapture.stopCapture(payload);
  }

  confirmAudioCapture(payload) {
    return this.mediaCapture.confirmCapture(payload);
  }

  cancelAudioCapture() {
    return this.mediaCapture.cancelCapture();
  }

  getAudioCaptureStatus() {
    return this.mediaCapture.getCaptureStatus();
  }

  async endContact(payload) {
    if (typeof this.desktop.agentContact.endV2 === "function") {
      return this.desktop.agentContact.endV2(payload);
    }

    return this.desktop.agentContact.end(payload);
  }

  async loadRuntimeProfile() {
    const runtimeProfile = window.AGENTX_SERVICE?.conf?.profile;

    if (runtimeProfile) {
      return runtimeProfile;
    }

    if (typeof window.AGENTX_SERVICE?.conf?.fetchProfile !== "function") {
      return null;
    }

    try {
      return await window.AGENTX_SERVICE.conf.fetchProfile();
    } catch (error) {
      this.logger.warn?.("Unable to fetch runtime profile", error);
      return null;
    }
  }
}

async function loadWxccDesktopSdk() {
  if (window.WxccDesktopSDK?.Desktop) {
    return;
  }

  await new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-wxcc-sdk="true"]');

    if (existingScript) {
      if (window.WxccDesktopSDK?.Desktop) {
        resolve();
        return;
      }

      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Failed to load WXCC SDK script.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = window.__ARK_WIDGET_CONFIG__?.sdkScriptPath ?? "./vendor/@wxcc-desktop/sdk/dist/index.js";
    script.dataset.wxccSdk = "true";
    script.crossOrigin = "anonymous";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load WXCC SDK script."));
    document.head.appendChild(script);
  });
}

function createContactListener(listener, eventName) {
  return (message) => {
    listener({
      source: "sdk",
      type: "agent-contact",
      eventName,
      payload: message
    });
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}
