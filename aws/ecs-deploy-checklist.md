# ECS Deployment Checklist

## Phase 1: Local container validation

1. Install Docker Desktop
2. From the repo root, build the image:

```bash
docker build -t ark-wxcc-widget .
```

3. Run the container locally:

```bash
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e WIDGET_BASE_PATH=/ \
  -e WIDGET_NAME=ark-widget \
  -e WIDGET_PROVIDER=ArkWidget \
  -e REQUIRE_AGENT_DESKTOP=true \
  -e LOG_LEVEL=INFO \
  -e POWERTOOLS_SERVICE_NAME=ark-wxcc-widget-host \
  -e LOG_TO_FILE=false \
  -e ARIES_API_TIMEOUT_MS=10000 \
  -e ARIES_NEW_CALL_ENDPOINT=/contact-arrivals \
  ark-wxcc-widget
```

4. Verify:

- `http://localhost:3000/health`
- `http://localhost:3000/desktop.js`
- `http://localhost:3000/config.js`

## Phase 2: AWS prerequisites

Create or confirm:

1. ECR repository
2. ECS cluster
3. ALB
4. ACM certificate
5. Route 53 record
6. CloudWatch log group
7. IAM roles:

- `ecsTaskExecutionRole`
- app task role for runtime permissions

8. SSM parameters or Secrets Manager entries for:

- `ARIES_API_BASE_URL`
- `ARIES_API_KEY`

## Phase 3: Push image to ECR

Example commands:

```bash
aws ecr create-repository --repository-name ark-wxcc-widget
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com

docker tag ark-wxcc-widget:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/ark-wxcc-widget:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/ark-wxcc-widget:latest
```

Replace account ID and region.

## Phase 4: Create task definition

Use:

- `aws/ecs-task-definition.example.json`

Update:

1. account IDs
2. region
3. role ARNs
4. ECR image URI
5. SSM parameter ARNs
6. log group name

Register the task definition:

```bash
aws ecs register-task-definition --cli-input-json file://aws/ecs-task-definition.example.json
```

## Phase 5: Create ECS service

Recommended starting values:

- launch type: Fargate
- desired tasks: 1
- health check path: `/health`
- target group port: 3000
- assign public IP: disabled if using private subnets + NAT, enabled only if your network design requires it

Important:

Start with one task because desktop command routing is currently in-memory.

## Phase 6: Configure ALB

1. HTTPS listener on 443
2. ACM certificate attached
3. Forward to the ECS target group
4. Optional HTTP 80 -> 443 redirect

## Phase 7: Point Webex Desktop to AWS

Use the ECS/ALB domain in the desktop layout:

```json
{
  "comp": "sa-ds-sdk",
  "script": "https://your-widget.example.com/desktop.js"
}
```

## Phase 8: Post-deploy validation

Verify in order:

1. `GET /health` returns 200
2. `GET /desktop.js` loads from the public URL
3. widget tab appears in Webex Desktop
4. desktop client registers in logs
5. `POST /api/desktop-command` reaches the correct desktop
6. outdial still works
7. recording still works with `#remote-audio`

## First production-safe defaults

Use these until the customer asks for more:

- one ECS task
- no local file logging
- send logs to CloudWatch only
- keep recordings proof-of-concept only
- use SSM for secrets
- do not enable autoscaling yet

## Good next automation steps

1. Add GitHub Actions to build and push the image to ECR
2. Add Terraform or CloudFormation for ECS, ALB, and IAM
3. Move recording persistence from local disk to S3
4. Redesign SSE client routing before scaling above one task
