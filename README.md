# Ark WXCC Widget

A starter Cisco Webex Contact Center Desktop widget built as a native web component, using the `@wxcc-desktop/sdk` package for Agent Desktop integration.

## What this scaffold includes

- A custom element, `ark-wxcc-widget`, rendered with Shadow DOM.
- WXCC Desktop SDK bootstrap via `Desktop.config.init()`.
- A bridge that reads Agent Desktop state from `$Store` when available and supplements it with WXCC SDK listeners.
- A Node.js host that:
  - serves the widget locally,
  - relays outbound calls to a third-party API,
  - exposes an SSE stream for browser-side command delivery,
  - accepts third-party webhook posts and broadcasts them into the widget.

## Local setup

The widget now requires the actual Webex Contact Center Agent Desktop runtime. Opening it in a plain browser without `AGENTX_SERVICE` will fail by design.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set your values.

3. Start the local host:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000`.

## Targeting Actual Agent Desktop

For a real Webex Contact Center Desktop deployment, set:

```bash
REQUIRE_AGENT_DESKTOP=true
```

This is now the default behavior. The widget fails fast if `AGENTX_SERVICE` is missing.

The WXCC SDK bundle is only loaded when the Agent Desktop runtime is present. That prevents the standalone browser crash caused by loading the SDK outside the Cisco desktop container.

## Embedding In Webex Contact Center Desktop

The desktop layout's `script` field must point at a JavaScript module, not the widget site's root URL.

Use:

```json
{
  "comp": "sa-ds-sdk",
  "script": "https://your-host.example.com/desktop.js"
}
```

The host now registers both custom element names:

- `ark-wxcc-widget` for the standalone page served by this project
- `sa-ds-sdk` for Agent Desktop layout configs that reference your widget directly

If `script` points at `https://your-host.example.com/` instead of `https://your-host.example.com/desktop.js`, Agent Desktop loads HTML instead of JavaScript and the page stays blank even though the navigation tab appears.

## Hosting Under Another Node Server

The widget host is now mountable under any path instead of assuming `/`.

Environment option:

```bash
WIDGET_BASE_PATH=/widgets/ark
```

When set, all generated runtime URLs are automatically prefixed, including:

- `config.js`
- the WXCC SDK script path
- `/api/third-party/forward`
- `/events`
- `/api/desktop-command`

You can also mount the widget inside another Express server by importing the reusable app factory from [server/app.js](server/app.js):

```js
import express from "express";
import { createArkWidgetApp } from "./server/app.js";

const app = express();

app.use(
  "/widgets/ark",
  createArkWidgetApp({
    mountPath: "/",
    requireAgentDesktop: true,
    ariesBaseUrl: process.env.ARIES_API_BASE_URL
  })
);

app.listen(8080);
```

If you prefer the widget host to own its own path directly, start it with `WIDGET_BASE_PATH=/widgets/ark` and browse to `http://host:port/widgets/ark`.

## Environment variables

Primary server-side config now uses the `ARIES_*` names:

```bash
PORT=3000
WIDGET_BASE_PATH=/
WIDGET_NAME=ark-widget
WIDGET_PROVIDER=ArkWidget
REQUIRE_AGENT_DESKTOP=true
LOG_LEVEL=INFO
POWERTOOLS_SERVICE_NAME=ark-wxcc-widget-host
LOG_TO_FILE=false
LOG_FILE_PATH=./logs/server.log
ARIES_API_BASE_URL=https://api.example.com
ARIES_API_KEY=replace-me
ARIES_API_TIMEOUT_MS=10000
ARIES_NEW_CALL_ENDPOINT=/contact-arrivals
```

Legacy `THIRD_PARTY_*` names are still accepted for backward compatibility, but new config should use `ARIES_*`.

## Logging

The server now uses `@aws-lambda-powertools/logger` so local Node logs already follow the same structured JSON pattern you will want in Lambda.

Useful environment variables:

```bash
LOG_LEVEL=INFO
POWERTOOLS_SERVICE_NAME=ark-wxcc-widget-host
LOG_TO_FILE=false
LOG_FILE_PATH=./logs/server.log
```

If you want a local file during Node-based development, set:

```bash
LOG_TO_FILE=true
LOG_FILE_PATH=./logs/server.log
```

When enabled, the server still writes structured JSON to stdout and also appends the same events to the local file path you configured.

Current server logs include:

- startup and uncaught failures
- incoming requests with request IDs
- SSE desktop connect and disconnect events
- desktop registration updates with `agentId` and `taskIds`
- desktop command routing decisions with `connectedClients` and `matchedClients`
- Aries forward start, success, timeout, and error conditions

For Lambda, keep the same logger package and create the logger once at module scope:

```js
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({
  serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "ark-wxcc-widget-host",
  logLevel: process.env.LOG_LEVEL ?? "INFO"
});

export const handler = async (event) => {
  logger.info("desktop command received", {
    requestId: event.requestContext?.requestId,
    routeKey: event.requestContext?.routeKey,
    rawPath: event.rawPath
  });

  try {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  } catch (error) {
    logger.error("lambda handler failed", { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal Server Error" })
    };
  }
};
```

Avoid logging secrets such as `ARIES_API_KEY`, auth headers, or full unsanitized customer payloads.

## Integration flow

1. The widget initializes the WXCC SDK with `WIDGET_NAME` and `WIDGET_PROVIDER`.
2. Agent Desktop data is read from `window.$Store` when present, and also supplemented by WXCC SDK events.
3. The widget posts normalized agent/contact payloads to `/api/third-party/forward`.
4. The Node host forwards those requests to your configured third-party API.
5. The third party can push commands back by POSTing to `/api/desktop-command`.
6. Connected widgets register their current `agentId` and active `taskIds` with the host.
7. The host delivers commands to the matching desktop when a command includes `agentId` or `taskId`, or broadcasts to all desktops when no target is supplied.

## Important notes

- The `$Store` contract can vary by desktop version and custom widget runtime. This scaffold treats it as an optional source and safely degrades to SDK-derived state.
- The command mapper currently supports a controlled set of actions such as notifications, state changes, hold/unhold, end contact, and DTMF.
- The command mapper currently supports notifications, state changes, outbound dialing, consult conference, hold/unhold, end contact, and DTMF.
- Runtime mistakes are surfaced immediately because the widget no longer has a standalone mock mode.
- For AWS Amplify hosting, the static `public/` app can stay largely unchanged. The Node relay layer would typically move behind API Gateway, Lambda, ECS, or another backend service.

## AWS deployment split

For the current architecture, the clean AWS deployment unit is an ECS-hosted Express service, not a hard front-end/backend split.

Why:

- `desktop.js` is generated dynamically by the Node host.
- `config.js` is generated dynamically and depends on the current request origin and mount path.
- `/events` uses Server-Sent Events for long-lived desktop command delivery.
- `/api/desktop-client`, `/api/desktop-command`, and `/api/third-party/forward` are all part of the same live routing surface.
- the widget's static assets under `public/` currently assume those dynamic endpoints live beside them.

That means the lowest-risk AWS separation is:

1. `ECS Fargate + Express` for the current Node host and widget assets.
2. `ALB` in front of the ECS service.
3. `ECR` for the container image.
4. `CloudWatch Logs` for stdout logs.
5. optional `S3` later for recording persistence instead of local disk.
6. optional `SSM Parameter Store` or `Secrets Manager` for `ARIES_*` values.

Treat Amplify as optional for a later phase, after you deliberately separate the dynamic bootstrap/config layer from the widget bundle.

### Included AWS artifacts

- [Dockerfile](Dockerfile) for containerizing the Express host
- [aws/ecs-task-definition.example.json](aws/ecs-task-definition.example.json) as a Fargate task definition template
- [aws/architecture.md](aws/architecture.md) for the recommended AWS service layout
- [aws/ecs-deploy-checklist.md](aws/ecs-deploy-checklist.md) for a beginner-friendly deployment sequence
- [.dockerignore](.dockerignore) to keep local artifacts out of the image

### Recommended AWS shape now

Use the desktop layout script URL from the ECS service directly:

```json
{
  "comp": "sa-ds-sdk",
  "script": "https://your-ecs-service.example.com/desktop.js"
}
```

This keeps `desktop.js`, `config.js`, the static widget assets, and the live command APIs on the same origin and avoids extra cross-origin and cache-coherency problems.

### Container build and run locally

Build:

```bash
docker build -t ark-wxcc-widget .
```

Run:

```bash
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e REQUIRE_AGENT_DESKTOP=true \
  -e ARIES_API_BASE_URL=https://api.example.com \
  -e ARIES_API_KEY=replace-me \
  ark-wxcc-widget
```

### Future split if the customer wants Amplify

If the customer later insists on Amplify for the widget bundle, the likely split is:

1. keep `desktop.js`, `config.js`, SSE, and command APIs on ECS
2. move only versioned static assets from `public/` to Amplify or S3 + CloudFront
3. change `desktop.js` so it bootstraps the widget from the static host while still pulling runtime config and APIs from ECS

That is a valid evolution, but it is a second step, not the best first deployment for the current codebase.

## Third-party command examples

Commands can be sent in broadcast mode or targeted mode.

Targeting fields supported by the host:

```json
{
  "type": "notification",
  "agentId": "AGENT_ID",
  "payload": {
    "title": "Supervisor message",
    "message": "Only this agent should receive it."
  }
}
```

or:

```json
{
  "type": "notification",
  "target": {
    "taskId": "TASK_ID"
  },
  "payload": {
    "title": "Task-specific update",
    "message": "Only the desktop with this task gets it."
  }
}
```

POST a command into the local host:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "notification",
    "payload": {
      "title": "Supervisor message",
      "message": "Please wrap up the current interaction.",
      "mode": "acknowledge"
    }
  }'
```

Trigger a state change:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "stateChange",
    "payload": {
      "state": "Idle",
      "auxCodeId": "AUX_CODE_ID"
    }
  }'
```

Start a consult conference:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "conference",
    "payload": {
      "interactionId": "INTERACTION_ID",
      "data": {
        "destinationType": "DN",
        "to": "15551234567"
      }
    }
  }'
```

The `conference` payload is passed directly to `Desktop.agentContact.consultConferenceV2(...)` when available, and falls back to `consultConference(...)` on older SDK surfaces.

Start a new outbound call:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "startOutdial",
    "agentId": "AGENT_ID",
    "payload": {
      "data": {
        "entryPointId": "ENTRY_POINT_ID",
        "direction": "OUTBOUND_ANI_CONFIGURATION_UUID",
        "destination": "4254223551",
        "attributes": {
          "key": "ani",
          "value": "WEBRTC_OR_TENANT_DEFINED_CALLER_ID"
        },
        "outboundType": "OUTDIAL",
        "mediaType": "telephony"
      }
    }
  }'
```

The `startOutdial` payload is passed directly to `Desktop.dialer.startOutdial(...)`. In practice, Aries must provide the exact dialer payload expected by your WXCC tenant configuration. In the tested WebRTC flow, `payload.data.direction` is the outbound ANI configuration UUID, not the entry point UUID. `payload.data.origin` is optional and can be omitted for WebRTC agents. The widget still rejects the literal placeholder `AGENT_DN` if it is sent.

Inspect whether the widget can see any recordable WebRTC media source:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "inspectMediaCapture",
    "agentId": "AGENT_ID"
  }'
```

Capture a short audio snippet from a visible audio or video element and post it to Aries as a normal JSON request containing metadata plus a base64 audio object:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "captureAudioSnippet",
    "agentId": "AGENT_ID",
    "payload": {
      "selector": "audio",
      "durationMs": 5000,
      "fileName": "telephonic-signature.webm",
      "metadata": {
        "memberId": "123456789",
        "caseId": "ABC-123",
        "interactionId": "INTERACTION_ID"
      },
      "delivery": {
        "endpoint": "/telephonic-signatures",
        "method": "POST",
        "includeCommand": false,
        "extraBody": {
          "source": "ark-widget"
        }
      }
    }
  }'
```

When `payload.delivery` is present, the browser records the clip locally, base64-encodes it, and forwards a JSON body to the configured Aries endpoint with this shape:

```json
{
  "source": "ark-widget",
  "metadata": {
    "memberId": "123456789",
    "caseId": "ABC-123",
    "interactionId": "INTERACTION_ID"
  },
  "audio": {
    "fileName": "telephonic-signature.webm",
    "mimeType": "audio/webm",
    "sizeBytes": 12345,
    "durationMs": 5000,
    "base64": "..."
  }
}
```

The capture path only works if the widget can access a live media element with either `srcObject` audio tracks or `captureStream()` support. It does not bypass browser or WXCC media isolation. The browser records in memory and posts JSON to the server. If `ARIES_API_BASE_URL` is not configured, the server now saves captured audio locally under `logs/recordings/` so you can validate the proof of concept without a live Aries endpoint. The server JSON limit is set to 10 MB so short signature clips can be forwarded.

Start a controlled recording session so Aries can decide exactly when capture begins:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "startAudioCapture",
    "agentId": "AGENT_ID",
    "payload": {
      "selector": "audio",
      "fileName": "telephonic-signature.webm",
      "metadata": {
        "memberId": "123456789",
        "caseId": "ABC-123",
        "interactionId": "INTERACTION_ID"
      }
    }
  }'
```

If `payload.metadata.interactionId` is omitted on `captureAudioSnippet`, `startAudioCapture`, or `stopAudioCapture`, the widget now fills it automatically from the current live call when one is available.

Stop the recording session and post the captured segment to Aries as JSON:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "stopAudioCapture",
    "agentId": "AGENT_ID",
    "payload": {
      "metadata": {
        "memberId": "123456789",
        "caseId": "ABC-123",
        "interactionId": "INTERACTION_ID",
        "signatureAccepted": true
      },
      "delivery": {
        "endpoint": "/telephonic-signatures",
        "method": "POST",
        "includeCommand": false,
        "extraBody": {
          "source": "ark-widget"
        }
      }
    }
  }'
```

Check whether a session is currently active:

```bash
curl -X POST http://localhost:3000/api/desktop-command \
  -H "Content-Type: application/json" \
  -d '{
    "type": "getAudioCaptureStatus",
    "agentId": "AGENT_ID"
  }'
```

Only one capture session is tracked at a time inside the widget. `startAudioCapture` keeps audio chunks in memory until `stopAudioCapture` is received. The `stopAudioCapture` payload can override or extend the metadata collected at start, and if a `delivery` block is present the final base64 audio payload is posted directly to Aries. When no Aries base URL is configured, that same payload is written to `logs/recordings/` as an audio file plus a sidecar metadata JSON file.
