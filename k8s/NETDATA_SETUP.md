# Netdata Integration for Cricket Backend

This guide explains how to add Netdata real-time monitoring to your cricket backend running on IBM Kubernetes Service (IKS).

## What You Get

- **Real-time CPU/Memory monitoring** for your Node.js backend
- **WebSocket connection tracking** via Socket.IO metrics
- **API request metrics** exposed at `/metrics` endpoint
- **Redis monitoring** (if using in your stack)
- **Docker/Kubernetes metrics** for container health
- **Optional Netdata Cloud** for centralized dashboard

## Files Created

| File | Purpose |
|------|---------|
| `netdata-config.yaml` | ConfigMap with Netdata settings |
| `deployment-netdata.yaml` | Updated deployment with Netdata sidecar |
| `netdata-service.yaml` | Service + Ingress for Netdata access |
| `setup-netdata.bat` | Quick setup script |

## Quick Setup

### Option 1: Full Setup (Recommended)

```bash
# 1. Apply ConfigMap
kubectl apply -f netdata-config.yaml -n cricket-game

# 2. Update deployment with Netdata sidecar
kubectl apply -f deployment-netdata.yaml -n cricket-game

# 3. Create service for Netdata
kubectl apply -f netdata-service.yaml -n cricket-game

# 4. Wait for rollout
kubectl rollout status deployment/cricket-backend -n cricket-game
```

### Option 2: Local Access Only

```bash
# Port-forward to access Netdata locally
kubectl port-forward -n cricket-game svc/cricket-backend-netdata 19999:19999

# Then open http://localhost:19999 in browser
```

## Accessing Netdata

### Inside Cluster
```bash
# Via service
curl http://cricket-backend-netdata.cricket-game.svc.cluster.local:19999

# Via pod exec
kubectl exec -n cricket-game deploy/cricket-backend -c netdata -- netdatacli info
```

### Local Access
```bash
kubectl port-forward -n cricket-game svc/cricket-backend-netdata 19999:19999
# Open: http://localhost:19999
```

### External Access (with Ingress)
Add to your DNS/hosts:
```
netdata.your-domain.com -> Ingress IP
```

## Netdata Cloud (Optional)

1. Create free account at https://app.netdata.cloud
2. Get your claim token from the dashboard
3. Update the deployment with your token:

```yaml
env:
  - name: NETDATA_CLAIM_TOKEN
    value: "your-claim-token-here"
```

4. Re-apply:
```bash
kubectl apply -f deployment-netdata.yaml -n cricket-game
```

## Metrics Available

### Node.js Metrics (from /metrics endpoint)
- `nodejs_memory_heap_used_bytes`
- `nodejs_memory_rss_bytes`
- `nodejs_cpu_user_seconds_total`
- `nodejs_active_handles_total`
- `cricket_api_requests_total`
- `cricket_uptime_seconds`

### Kubernetes Metrics
- Pod CPU/Memory usage
- Container restart counts
- Network I/O
- Pod scheduling status

### System Metrics
- CPU usage per core
- Memory and swap
- Disk I/O
- Network traffic

## Troubleshooting

### Netdata not starting?
```bash
# Check logs
kubectl logs -n cricket-game deploy/cricket-backend -c netdata

# Check events
kubectl describe pod -n cricket-game -l app=cricket-backend
```

### Can't access dashboard?
```bash
# Verify service
kubectl get svc cricket-backend-netdata -n cricket-game

# Check endpoints
kubectl get endpoints cricket-backend-netdata -n cricket-game
```

### Memory issues?
Reduce Netdata history size in `netdata-config.yaml`:
```yaml
[global]
  memory mode = ram
  dbengine multihost disk space = 128  # Reduce from 256
```

## Removing Netdata

```bash
kubectl delete -f netdata-service.yaml -n cricket-game
kubectl delete -f deployment-netdata.yaml -n cricket-game
kubectl delete -f netdata-config.yaml -n cricket-game
```

## Cost Estimate

Netdata sidecar adds ~50-100MB memory and ~50m CPU. For 2 replicas:
- **Memory**: +100-200MB
- **CPU**: ~100m total

This is minimal and should fit within your existing resource limits.