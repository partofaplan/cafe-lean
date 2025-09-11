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
