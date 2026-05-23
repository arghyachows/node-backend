@echo off
REM Netdata Setup Script for Cricket Backend on IBM Kubernetes
REM Run this after updating your deployment

echo ========================================
echo Netdata Integration Setup for IKS
echo ========================================
echo.

echo Step 1: Applying ConfigMap...
kubectl apply -f netdata-config.yaml -n cricket-game

echo.
echo Step 2: Updating Deployment with Netdata sidecar...
kubectl apply -f deployment-netdata.yaml -n cricket-game

echo.
echo Step 3: Creating Service for Netdata...
kubectl apply -f netdata-service.yaml -n cricket-game

echo.
echo Step 4: Waiting for pods to be ready...
kubectl rollout status deployment/cricket-backend -n cricket-game --timeout=120s

echo.
echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo Access options:
echo 1. Port-forward for local access:
echo    kubectl port-forward -n cricket-game svc/cricket-backend-netdata 19999:19999
echo.
echo 2. Check Netdata is running:
echo    kubectl exec -n cricket-game deploy/cricket-backend -c netdata -- netdatacli info
echo.
echo 3. View logs:
echo    kubectl logs -n cricket-game deploy/cricket-backend -c netdata
echo.
echo 4. For Netdata Cloud (optional):
echo    kubectl exec -n cricket-game deploy/cricket-backend -c netdata -- netdata-claim.sh
echo.
pause