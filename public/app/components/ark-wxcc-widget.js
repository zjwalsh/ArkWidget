const template = document.createElement("template");
template.innerHTML = `
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
`;

export class ArkWxccWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.statusElement = this.shadowRoot.getElementById("status");
    this.latestEventText = "Waiting for Agent Desktop data...";
    this.latestCommandText = "Waiting for third-party commands...";
  }

  connectedCallback() {}

  setHandlers({ onSync, onSimulate }) {
    this.handleSync = onSync;
    this.handleSimulate = onSimulate;
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

defineWidgetElement("ark-wxcc-widget");
defineWidgetElement("sa-ds-sdk");

function defineWidgetElement(tagName) {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, ArkWxccWidget);
  }
}
