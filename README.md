# Cafe Lean — Lean Coffee Webapp

A minimal Lean Coffee board with a shared display, admin controls, and participant voting.

## Run with Docker

- Build image:
  - `docker build -t cafe-lean .`
- Run container:
  - `docker run --rm -p 3000:3000 -e MAX_VOTES=3 --name cafe-lean cafe-lean`
- Open:
  - `http://localhost:3000`

Notes:
- The board is at `/board/:MEETING_ID`.
- Admin controls are at `/admin/:MEETING_ID` and require the admin token created when the meeting is created.
- Participants join at `/join/:MEETING_ID` to submit topics and vote.

## docker-compose (optional)

```yaml
version: '3.8'
services:
  app:
    build: .
    image: cafe-lean
    environment:
      NODE_ENV: production
      MAX_VOTES: 3
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:3000/ || exit 1"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s
```

## Development (without Docker)

- Install deps: `npm ci`
- Start: `npm run dev`
- Open: `http://localhost:3000`

## Environment

- `PORT`: server port (default `3000`)
- `MAX_VOTES`: votes per participant (default `3`)

Data is in-memory for this MVP; a restart clears meetings. For production, add a backing store (Redis/Postgres) and persist sessions.

## Meeting Phases and Timers

- Phases: Create Topics, Voting, Discussing.
- Admin controls (on `/admin/:MEETING_ID`):
  - Set timer durations (minutes) for each phase.
  - Start Create/Voting phases, start discussion for a selected topic, add +1 minute, or end current phase.
- Participants:
  - Can submit topics only during Create phase.
  - Can vote only during Voting phase (3 votes per participant).
  - See the current phase and countdown.

## Helm (Kubernetes)

This repo includes a Helm chart for deploying with Traefik Ingress and an sslip.io endpoint.

- Build and tag your image locally:
  - `docker build -t cafe-lean:latest .`
- Load the image to your cluster (optional for kind/minikube):
  - kind: `kind load docker-image cafe-lean:latest`
  - minikube: `minikube image load cafe-lean:latest`
- Install the chart:
  - `helm install lean ./helm/cafe-lean \
      --set image.repository=cafe-lean \
      --set image.tag=latest \
      --set ingress.enabled=true \
      --set ingress.className=traefik \
      --set ingress.host=cafe-lean.127.0.0.1.sslip.io`

Then open: `http://cafe-lean.127.0.0.1.sslip.io`

Notes:
- Ensure Traefik is installed and your cluster can resolve the sslip.io host to the node/ingress IP.
- For a public IP, replace `127.0.0.1` with your ingress IP (e.g., `10.0.0.5.sslip.io`).
- Enable TLS if your Traefik is configured with ACME:
  - `--set ingress.tls.enabled=true --set ingress.tls.secretName=<existingSecret>`
