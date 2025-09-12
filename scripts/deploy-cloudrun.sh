#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   PROJECT_ID=your-project REGION=us-central1 SERVICE=cafe-lean ./scripts/deploy-cloudrun.sh

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION}"
: "${SERVICE:=cafe-lean}"

IMAGE="gcr.io/${PROJECT_ID}/${SERVICE}:$(git rev-parse --short HEAD)"

echo "Building ${IMAGE}..."
gcloud builds submit --tag "${IMAGE}" .

echo "Deploying to Cloud Run service ${SERVICE} in ${REGION}..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 3000 \
  --cpu 0.5 --memory 512Mi \
  --max-instances 1 \
  --set-env-vars MAX_VOTES=3,DEFAULT_CREATE_MIN=5,DEFAULT_VOTING_MIN=3,DEFAULT_DISCUSS_MIN=5

echo "Done. URL:"
gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)'

