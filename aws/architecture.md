# Ark WXCC Widget AWS Architecture

## Goal

Deploy the current project to AWS with the fewest moving parts and the lowest risk.

## Recommended shape

Use one containerized Express service on ECS Fargate behind an Application Load Balancer.

Flow:

1. Webex Contact Center loads `https://your-domain.example.com/desktop.js`
2. The ECS service returns dynamic `desktop.js`
3. `desktop.js` loads dynamic `config.js` and static app assets from the same service
4. The browser widget opens `/events` for SSE command delivery
5. Aries or Postman sends commands to `/api/desktop-command`
6. The Express service routes commands to the connected desktop session
7. The widget posts event data and command results back to `/api/third-party/forward`

## AWS services

Required now:

- ECS Fargate: runs the Node/Express container
- ECR: stores the Docker image
- ALB: public HTTP/HTTPS entrypoint for the service
- CloudWatch Logs: application logs
- IAM: task execution role and task role

Recommended:

- ACM: TLS certificate for HTTPS on the ALB
- Route 53: DNS for a clean widget hostname
- SSM Parameter Store or Secrets Manager: stores `ARIES_*` secrets

Optional later:

- S3: store recordings instead of local container filesystem
- CloudFront: front the ALB if customer networking requires it
- WAF: edge protection if the service will be internet-facing

## Why not split first

The current codebase couples these together:

- dynamic `desktop.js`
- dynamic `config.js`
- static `public/` assets
- `/events` SSE stream
- `/api/desktop-client`
- `/api/desktop-command`
- `/api/third-party/forward`

That means one ECS service is the simplest correct deployment.

## Runtime boundaries

### Front-end inside the container

These files are served directly by Express:

- `public/`
- `desktop.js`
- `config.js`
- `vendor/@wxcc-desktop/sdk/...`

### Back-end inside the container

These routes stay in the same service:

- `/events`
- `/api/desktop-client`
- `/api/desktop-command`
- `/api/third-party/forward`
- `/health`

## Network model

- ALB listener 443 -> ECS target group port 3000
- ECS tasks in private subnets if possible
- ALB in public subnets
- security group: ALB accepts 443 from approved client ranges or internet
- ECS task security group: allow inbound 3000 only from ALB security group

## State considerations

The current SSE client registry is in-memory.

That means:

- one running task is the simplest deployment
- if you scale to multiple ECS tasks later, command routing will need shared session coordination or sticky routing

Start with:

- desired count = 1

Only scale horizontally after deciding how to coordinate connected desktop sessions.

## Storage considerations

Local proof-of-concept recording files are written inside the container filesystem. That is fine for validation, but not durable in production.

Production options later:

1. send recordings directly to Aries
2. store recordings in S3
3. store metadata in DynamoDB if indexing/search is needed

## Environment variables to set in ECS

Minimum:

- `PORT=3000`
- `WIDGET_BASE_PATH=/`
- `WIDGET_NAME=ark-widget`
- `WIDGET_PROVIDER=ArkWidget`
- `REQUIRE_AGENT_DESKTOP=true`
- `LOG_LEVEL=INFO`
- `POWERTOOLS_SERVICE_NAME=ark-wxcc-widget-host`
- `LOG_TO_FILE=false`
- `ARIES_API_TIMEOUT_MS=10000`
- `ARIES_NEW_CALL_ENDPOINT=/contact-arrivals`

Set from secrets when available:

- `ARIES_API_BASE_URL`
- `ARIES_API_KEY`

## Production caveats

- Do not rely on container local disk for real recordings
- Use HTTPS for the widget URL in Webex Desktop
- Start with a single ECS task because SSE routing is in-memory
- Add ALB health checks using `/health`
- Keep secrets out of the task definition JSON

## Future evolution

If the customer later wants Amplify, split in this order:

1. keep Express on ECS for `desktop.js`, `config.js`, SSE, and APIs
2. move only versioned static app assets to a static host
3. teach `desktop.js` to load static assets from that host

Do not do that first unless the customer explicitly requires it.
