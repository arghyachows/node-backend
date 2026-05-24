# Build and push the Docker image to Docker Desktop's local registry
# Run this from the node-backend directory

# 1. Build the image for local registry
docker build -t cricket-backend:latest .

# 2. Tag for local Kubernetes (Docker Desktop uses docker-for-desktop context)
docker tag cricket-backend:latest cricket-backend:latest

# 3. Load image into Kubernetes (for Docker Desktop)
# Option A: Using Docker Desktop's built-in Kubernetes
docker save cricket-backend:latest | sudo k3s ctr images import -

# Option B: If using minikube
# eval $(minikube docker-env)
# docker build -t cricket-backend:latest .

# Option C: For Kind cluster
# kind load docker-image cricket-backend:latest

# 4. Deploy to Kubernetes
kubectl apply -k k8s/

# 5. Check deployment status
kubectl get pods -n cricket-backend

# 6. View logs
kubectl logs -n cricket-backend -l app=backend -f

# 7. Access the service
# Get the NodePort
kubectl get svc -n cricket-backend

# Access at http://localhost:<NODE_PORT>