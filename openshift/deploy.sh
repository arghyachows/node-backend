#!/usr/bin/env bash
# Deploy the backend + Redis to the current OpenShift project.
# Prereq: `oc login ...` and `oc project <name>`.
# Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
# Optional env: IBM_CLOUD_API_KEY, WATSONX_PROJECT_ID, REDIS_PASSWORD
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_KEY:?SUPABASE_SERVICE_KEY is required}"

if [ -z "${REDIS_PASSWORD:-}" ]; then
  REDIS_PASSWORD=$(oc get secret cricket-backend-secrets -o jsonpath='{.data.REDIS_PASSWORD}' 2>/dev/null | base64 -d || true)
  [ -n "$REDIS_PASSWORD" ] || REDIS_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi

echo "==> Creating/updating secret"
oc create secret generic cricket-backend-secrets \
  --from-literal=SUPABASE_URL="$SUPABASE_URL" \
  --from-literal=SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  --from-literal=IBM_CLOUD_API_KEY="${IBM_CLOUD_API_KEY:-}" \
  --from-literal=WATSONX_PROJECT_ID="${WATSONX_PROJECT_ID:-}" \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD" \
  --dry-run=client -o yaml | oc apply -f -

echo "==> Applying manifests"
oc apply -f openshift/redis.yaml -f openshift/backend.yaml

echo "==> Building image from local source"
oc start-build cricket-backend --from-dir=. --follow --wait

oc rollout status deployment/cricket-redis --timeout=5m
oc rollout status deployment/cricket-backend --timeout=5m

echo "Backend URL: https://$(oc get route cricket-backend -o jsonpath='{.spec.host}')"
