@echo off
REM ============================================================
REM  Deploy Cricket Backend to IBM Cloud Kubernetes Service (IKS)
REM ============================================================
setlocal enabledelayedexpansion

echo.
echo ============================================
echo  Cricket Backend - IKS Deployment Script
echo ============================================
echo.

REM ── Configuration ──────────────────────────────────────────
set CLUSTER_NAME=cricket-cluster
set REGION=us-south
set NAMESPACE=cricket-game
set IMAGE_TAG=latest
set ICR_NAMESPACE=cricket-game
set ICR_REGISTRY=icr.io

REM ── Step 1: Login to IBM Cloud ────────────────────────────
echo [1/7] Logging into IBM Cloud...
ibmcloud login --apikey %IBM_CLOUD_API_KEY% -r %REGION%
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: IBM Cloud login failed. Set IBM_CLOUD_API_KEY env var.
    exit /b 1
)

REM ── Step 2: Target the IKS cluster ────────────────────────
echo [2/7] Configuring kubectl for cluster: %CLUSTER_NAME%...
ibmcloud ks cluster config --cluster %CLUSTER_NAME% --admin
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to get cluster config. Is the cluster created?
    exit /b 1
)

REM ── Step 3: Login to IBM Container Registry ───────────────
echo [3/7] Logging into IBM Container Registry...
ibmcloud cr login
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Container Registry login failed.
    exit /b 1
)

REM ── Step 4: Build & Push Docker Image ─────────────────────
echo [4/7] Building Docker image...
docker build -t %ICR_REGISTRY%/%ICR_NAMESPACE%/cricket-backend:%IMAGE_TAG% .
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker build failed.
    exit /b 1
)

echo [5/7] Pushing image to ICR...
docker push %ICR_REGISTRY%/%ICR_NAMESPACE%/cricket-backend:%IMAGE_TAG%
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker push failed.
    exit /b 1
)

REM ── Step 5: Create namespace & apply manifests ────────────
echo [6/7] Applying Kubernetes manifests...
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/config.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml

REM ── Step 6: Verify deployment ─────────────────────────────
echo [7/7] Verifying deployment...
echo.
echo Waiting for pods to be ready...
kubectl -n %NAMESPACE% wait --for=condition=ready pod -l app=cricket-backend --timeout=120s
kubectl -n %NAMESPACE% wait --for=condition=ready pod -l app=cricket-redis --timeout=60s

echo.
echo ============================================
echo  Deployment Status
echo ============================================
kubectl -n %NAMESPACE% get pods,svc,ingress
echo.
echo Done! Your backend is deploying to IKS.
echo Check logs: kubectl -n %NAMESPACE% logs -f deployment/cricket-backend
echo.