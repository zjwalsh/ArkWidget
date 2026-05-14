export class CommandStream {
  constructor(config) {
    this.config = config;
    this.eventSource = null;
    this.clientId = null;
  }

  connect({ onCommand, onReady, onStatus }) {
    this.eventSource = new EventSource(this.config.commandStreamPath);

    this.eventSource.addEventListener("ready", (event) => {
      const payload = JSON.parse(event.data);
      this.clientId = payload.clientId ?? null;
      onReady?.(payload);
      onStatus?.("Command stream connected");
    });

    this.eventSource.addEventListener("desktop-command", (event) => {
      const command = JSON.parse(event.data);
      onCommand(command);
    });

    this.eventSource.onerror = () => {
      onStatus?.("Command stream connection issue");
    };
  }

  disconnect() {
    this.eventSource?.close();
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
      throw new Error(data?.error ?? `Desktop client registration failed with status ${response.status}`);
    }

    return data;
  }
}
