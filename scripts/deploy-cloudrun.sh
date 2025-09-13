#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   PROJECT_ID=your-project REGION=us-central1 SERVICE=cafe-lean ./scripts/deploy-cloudrun.sh

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION}"
: "${SERVICE:=cafe-lean}"

# Image to deploy. Default uses your Docker Hub repo/tag.
# Override with IMAGE=... to use a different registry (e.g., gcr.io/PROJECT/SERVICE:tag)
: "${IMAGE:=docker.io/partofaplan/cafe-lean:0.2.1}"

if [[ "$IMAGE" == gcr.io/* || "$IMAGE" == *.pkg.dev/* ]]; then
  echo "Building ${IMAGE} via Cloud Build..."
  gcloud builds submit --tag "${IMAGE}" .
else
  echo "Using external image ${IMAGE}; skipping Cloud Build."
fi

echo "Deploying to Cloud Run service ${SERVICE} in ${REGION}..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 3000 \
  --cpu 1 --memory 512Mi \
  --concurrency 500 \
  --timeout 3600 \
  --max-instances 1 \
  --min-instances 1 \
  --set-env-vars MAX_VOTES=3,DEFAULT_CREATE_MIN=5,DEFAULT_VOTING_MIN=3,DEFAULT_DISCUSS_MIN=5

echo "Done. URL:"
gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)'
