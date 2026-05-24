# Cricket Backend Kubernetes Deployment Guide for Docker Desktop

## Prerequisites

1. **Docker Desktop with Kubernetes enabled**
   - Install Docker Desktop: https://docs.docker.com/desktop/
   - Enable Kubernetes: Docker Desktop → Settings → Kubernetes → Enable Kubernetes
   - Wait for Kubernetes to be ready (green indicator)

2. **kubectl installed**
   ```bash
   # macOS
   brew install kubectl
   
   # Windows (with Chocolatey)
   choco install kubernetes-cli
   
   # Linux
   curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
   chmod +x kubectl
   sudo mv kubectl /usr/local/bin/
   ```

3. **Verify Kubernetes is running**
   ```bash
   kubectl cluster-info
   kubectl get nodes
   ```

## Deployment Steps

### Step 1: Update Secrets

Edit `k8s/secret.yaml` and add your actual credentials:

```yaml
stringData:
  SUPABASE_URL: "https://your-project.supabase.co"
  SUPABASE_SERVICE_KEY: "your-actual-service-key"
  CLOUDFLARE_AI_WORKER_URL: "https://your-worker.workers.dev"
```

Or create secrets from your existing .env file:
```bash
kubectl create secret generic backend-secrets --from-env-file=.env -n cricket-backend
```

### Step 2: Build the Docker Image

```bash
cd /home/arghya-chowdhury/Documents/projects/node-backend

# Build the image
docker build -t cricket-backend:latest .
```

### Step 3: Load Image into Kubernetes

For Docker Desktop, load the image directly:

```bash
# Save and import image
docker save cricket-backend:latest | docker exec -i $(docker ps -q -f name=docker-desktop) ctr image import -
```

Alternative (if above doesn't work):
```bash
# Tag for docker-desktop registry
docker tag cricket-backend:latest docker-desktop/cricket-backend:latest
```

### Step 4: Deploy to Kubernetes

```bash
# Apply all Kubernetes resources
kubectl apply -k k8s/

# Or apply individually
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/redis-deployment.yaml
kubectl apply -f k8s/backend-deployment.yaml
```

### Step 5: Verify Deployment

```bash
# Check all resources
kubectl get all -n cricket-backend

# Check pods status
kubectl get pods -n cricket-backend -w

# Check logs
kubectl logs -n cricket-backend -l app=backend --tail=100
```

### Step 6: Access the Application

```bash
# Get the NodePort
kubectl get svc -n cricket-backend

# Access the API
curl http://localhost:<NODE_PORT>/health
```

## Common Commands

```bash
# Restart deployment
kubectl rollout restart deployment/backend -n cricket-backend

# Update after code changes
docker build -t cricket-backend:latest . && \
docker save cricket-backend:latest | docker exec -i $(docker ps -q -f name=docker-desktop) ctr image import - && \
kubectl rollout restart deployment/backend -n cricket-backend

# Delete all resources
kubectl delete -k k8s/

# Check resource details
kubectl describe deployment/backend -n cricket-backend
kubectl describe pod -n cricket-backend -l app=backend

# Execute into pod
kubectl exec -it -n cricket-backend $(kubectl get pod -n cricket-backend -l app=backend -o name) -- sh
```

## Troubleshooting

### Pod not starting?
```bash
kubectl describe pod <pod-name> -n cricket-backend
kubectl logs <pod-name> -n cricket-backend
```

### Image pull error?
```bash
# Ensure image is loaded
docker images | grep cricket-backend
```

### Redis connection error?
```bash
# Check Redis is running
kubectl get pods -n cricket-backend -l app=redis
kubectl logs -n cricket-backend -l app=redis
```

## Production Considerations

For a real production deployment, consider:
1. Using a private container registry
2. Adding PersistentVolumeClaims for Redis data
3. Setting up Ingress controller with TLS
4. Configuring resource limits and HPA (Horizontal Pod Autoscaler)
5. Setting up proper secret management (Vault, AWS Secrets Manager)