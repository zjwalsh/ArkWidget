export class CommandStream {
  constructor(config) {
    this.config = config;
    this.eventSource = null;
    this.clientId = null;
    this.reconnectTimerId = null;
    this.handlers = null;
    this.manuallyDisconnected = false;
    this.reconnectDelayMs = 1000;
  }

  connect({ onCommand, onReady, onStatus }) {
    this.handlers = { onCommand, onReady, onStatus };
    this.manuallyDisconnected = false;
    this.openEventSource();
  }

  disconnect() {
    this.manuallyDisconnected = true;
    this.clientId = null;
    this.clearReconnectTimer();
    this.eventSource?.close();
    this.eventSource = null;
  }

  reconnectNow() {
    this.clientId = null;
    this.manuallyDisconnected = false;
    this.clearReconnectTimer();
    this.eventSource?.close();
    this.eventSource = null;
    this.openEventSource();
  }

  async registerClient(identity) {
    if (!this.clientId) {
      return null;
    }

    const response = await fetch(this.config.desktopRegistrationPath, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: this.clientId,
        ...identity
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data?.error ?? `Desktop client registration failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return data;
  }

  openEventSource() {
    if (this.manuallyDisconnected) {
      return;
    }

    this.clearReconnectTimer();
    this.eventSource?.close();

    const eventSource = new EventSource(this.config.commandStreamPath);
    this.eventSource = eventSource;

    eventSource.addEventListener("ready", (event) => {
      if (this.eventSource !== eventSource) {
        return;
      }

      const payload = JSON.parse(event.data);
      this.clientId = payload.clientId ?? null;
      this.handlers?.onReady?.(payload);
      this.handlers?.onStatus?.("Command stream connected");
    });

    eventSource.addEventListener("desktop-command", (event) => {
      if (this.eventSource !== eventSource) {
        return;
      }

      const command = JSON.parse(event.data);
      this.handlers?.onCommand?.(command);
    });

    eventSource.onerror = () => {
      if (this.eventSource !== eventSource || this.manuallyDisconnected) {
        return;
      }

      this.clientId = null;
      this.handlers?.onStatus?.("Command stream connection issue");
      eventSource.close();
      this.eventSource = null;
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.manuallyDisconnected || this.reconnectTimerId !== null) {
      return;
    }

    this.reconnectTimerId = window.setTimeout(() => {
      this.reconnectTimerId = null;
      this.openEventSource();
    }, this.reconnectDelayMs);
  }

  clearReconnectTimer() {
    if (this.reconnectTimerId === null) {
      return;
    }

    window.clearTimeout(this.reconnectTimerId);
    this.reconnectTimerId = null;
  }
}
