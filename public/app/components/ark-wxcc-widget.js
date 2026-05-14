const template = document.createElement("template");
template.innerHTML = `
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
      align-items: start;
    }

    .panel {
      display: flex;
      flex-direction: column;
      border-radius: 20px;
      padding: 18px;
      background: linear-gradient(180deg, rgba(250, 251, 252, 0.95), rgba(239, 244, 248, 0.9));
      border: 1px solid rgba(19, 118, 180, 0.12);
      min-height: 200px;
      max-height: 420px;
      min-width: 0;
      overflow: hidden;
    }

    .panel h2 {
      margin: 0 0 12px;
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #486581;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .panel-header h2 {
      margin: 0;
    }

    .panel-tools {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
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
      flex: 1;
      min-height: 0;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #243b53;
      padding-right: 6px;
      scrollbar-gutter: stable;
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

    .tool-button {
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1;
      background: rgba(16, 42, 67, 0.08);
      color: #102a43;
    }

    .tool-button:hover {
      background: rgba(16, 42, 67, 0.14);
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
      min-width: 0;
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

    .overlay[hidden] {
      display: none;
    }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(16, 42, 67, 0.68);
    }

    .overlay-card {
      width: min(960px, 100%);
      max-height: min(85vh, 900px);
      display: flex;
      flex-direction: column;
      border-radius: 24px;
      overflow: hidden;
      background: white;
      box-shadow: 0 28px 80px rgba(16, 42, 67, 0.32);
    }

    .overlay-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid rgba(16, 42, 67, 0.08);
      background: linear-gradient(180deg, rgba(250, 251, 252, 0.98), rgba(239, 244, 248, 0.94));
    }

    .overlay-title {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: #102a43;
    }

    .overlay-content {
      margin: 0;
      padding: 20px;
      overflow: auto;
      max-height: 70vh;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #243b53;
      background: white;
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
        <div class="panel-header">
          <h2>Latest Desktop Event</h2>
          <div class="panel-tools">
            <button class="tool-button" id="expand-event" type="button">Expand</button>
            <button class="tool-button" id="copy-event" type="button">Copy</button>
          </div>
        </div>
        <pre id="event">Waiting for Agent Desktop data...</pre>
      </article>
      <article class="panel">
        <div class="panel-header">
          <h2>Latest Command</h2>
          <div class="panel-tools">
            <button class="tool-button" id="expand-command" type="button">Expand</button>
            <button class="tool-button" id="copy-command" type="button">Copy</button>
          </div>
        </div>
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
  <div class="overlay" id="overlay" hidden>
    <section class="overlay-card" role="dialog" aria-modal="true" aria-labelledby="overlay-title">
      <div class="overlay-header">
        <h2 class="overlay-title" id="overlay-title">Details</h2>
        <div class="panel-tools">
          <button class="tool-button" id="copy-overlay" type="button">Copy</button>
          <button class="tool-button" id="close-overlay" type="button">Close</button>
        </div>
      </div>
      <pre class="overlay-content" id="overlay-content"></pre>
    </section>
  </div>
`;

export class ArkWxccWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.statusElement = this.shadowRoot.getElementById("status");
    this.eventElement = this.shadowRoot.getElementById("event");
    this.commandElement = this.shadowRoot.getElementById("command");
    this.agentIdElement = this.shadowRoot.getElementById("agent-id");
    this.taskIdsElement = this.shadowRoot.getElementById("task-ids");
    this.interactionIdsElement = this.shadowRoot.getElementById("interaction-ids");
    this.syncButton = this.shadowRoot.getElementById("sync");
    this.simulateButton = this.shadowRoot.getElementById("simulate");
    this.expandEventButton = this.shadowRoot.getElementById("expand-event");
    this.copyEventButton = this.shadowRoot.getElementById("copy-event");
    this.expandCommandButton = this.shadowRoot.getElementById("expand-command");
    this.copyCommandButton = this.shadowRoot.getElementById("copy-command");
    this.overlayElement = this.shadowRoot.getElementById("overlay");
    this.overlayTitleElement = this.shadowRoot.getElementById("overlay-title");
    this.overlayContentElement = this.shadowRoot.getElementById("overlay-content");
    this.copyOverlayButton = this.shadowRoot.getElementById("copy-overlay");
    this.closeOverlayButton = this.shadowRoot.getElementById("close-overlay");
    this.handleSync = null;
    this.handleSimulate = null;
    this.latestEventText = "Waiting for Agent Desktop data...";
    this.latestCommandText = "Waiting for third-party commands...";
  }

  connectedCallback() {
    this.syncButton.addEventListener("click", () => this.handleSync?.());
    this.simulateButton.addEventListener("click", () => this.handleSimulate?.());
    this.expandEventButton.addEventListener("click", () => this.openOverlay("Latest Desktop Event", this.latestEventText));
    this.copyEventButton.addEventListener("click", () => copyText(this.latestEventText));
    this.expandCommandButton.addEventListener("click", () => this.openOverlay("Latest Command", this.latestCommandText));
    this.copyCommandButton.addEventListener("click", () => copyText(this.latestCommandText));
    this.copyOverlayButton.addEventListener("click", () => copyText(this.overlayContentElement.textContent || ""));
    this.closeOverlayButton.addEventListener("click", () => this.closeOverlay());
    this.overlayElement.addEventListener("click", (event) => {
      if (event.target === this.overlayElement) {
        this.closeOverlay();
      }
    });
  }

  setHandlers({ onSync, onSimulate }) {
    this.handleSync = onSync;
    this.handleSimulate = onSimulate;
  }

  updateStatus(message) {
    this.statusElement.textContent = message;
  }

  showDesktopEvent(event) {
    this.latestEventText = formatData(event);
    this.eventElement.textContent = this.latestEventText;
  }

  showCommand(command) {
    this.latestCommandText = formatData(command);
    this.commandElement.textContent = this.latestCommandText;
  }

  showIdentifiers(identifiers) {
    this.agentIdElement.textContent = identifiers?.agentId ?? "Not available yet";
    this.taskIdsElement.textContent = formatIdentifierList(identifiers?.taskIds);
    this.interactionIdsElement.textContent = formatIdentifierList(identifiers?.interactionIds);
  }

  openOverlay(title, content) {
    this.overlayTitleElement.textContent = title;
    this.overlayContentElement.textContent = content;
    this.overlayElement.hidden = false;
  }

  closeOverlay() {
    this.overlayElement.hidden = true;
  }
}

async function copyText(value) {
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Ignore clipboard failures in constrained desktop hosts.
  }
}

function formatData(value) {
  return safeStringify(value);
}

function safeStringify(value) {
  const seen = new WeakSet();

  try {
    return JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "function") {
          return `[Function ${currentValue.name || "anonymous"}]`;
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
      },
      2
    );
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }, null, 2);
  }
}

function formatIdentifierList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "Not available yet";
  }

  return values.join("\n");
}

defineWidgetElement("ark-wxcc-widget");
defineWidgetElement("sa-ds-sdk");

function defineWidgetElement(tagName) {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, ArkWxccWidget);
  }
}
