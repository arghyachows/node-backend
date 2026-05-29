# ☁️ Oracle Cloud Infrastructure (OCI) Deployment Guide

This guide provides step-by-step instructions for deploying and hosting the **Cricket Ultimate Manager Backend** on an **Oracle Cloud Infrastructure (OCI)** Compute VM, and hosting/deploying the **Frontend** directly to an **OCI Object Storage Bucket** as a static website behind the Nginx reverse proxy.

---

## 🏗️ Architecture Overview

The production architecture consists of the following components:

1.  **OCI Compute VM**:
    *   **Nginx Reverse Proxy**: Listens on ports `80` (HTTP) and `443` (HTTPS) to terminate SSL. It forwards incoming REST API requests to the local Node.js backend, and dynamically reverse-proxies frontend requests (`/*`) to the OCI Object Storage bucket.
    *   **Docker Container - Node.js Backend**: Express REST API and Socket.IO real-time match engine running on port `3000`.
    *   **Docker Container - Redis Cache**: Redis instance running on port `6379` (isolated locally) for state caching.
2.  **OCI Object Storage**:
    *   **Public Bucket**: Hosts all built Flutter Web frontend assets (`index.html`, JS, CSS, WASM, assets).

---

## 🌐 Phase 1: OCI Dashboard Configuration (Security Lists)

Oracle Cloud instances block all incoming traffic at the Virtual Cloud Network (VCN) level by default (except for SSH on port 22). Before configuring the VM, you must permit traffic through the OCI console.

### 📝 Step-by-Step VCN Ingress Rules

1.  Log in to the **OCI Console**.
2.  Navigate to **Compute** -> **Instances** and select your VM.
3.  Under the **Instance details** tab, click on the **Primary VNIC** subnet link.
4.  In the Subnet page, click on your **Default Security List** (e.g., `Security List for vcn-xxxx`).
5.  Click **Add Ingress Rules** and add the following rules:

| Source CIDR | IP Protocol | Source Port Range | Destination Port Range | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0.0.0.0/0` | TCP | All | `80` | HTTP (Web traffic/Certbot) |
| `0.0.0.0/0` | TCP | All | `443` | HTTPS (Secure web traffic) |

> [!IMPORTANT]
> The VCN security list defines external packet entry. Even if you open ports inside your VM firewall, they will remain unreachable unless these Ingress Rules are configured in the OCI dashboard.

---

## 🐧 Phase 2: OS Firewall & Package Setup

Once the OCI dashboard is configured, you must configure the internal OS firewall. Oracle Cloud Linux and Ubuntu images include strict iptables rules by default.

We have created an automated setup script: [oci-vm-setup.sh](file:///d:/Vibe/node-backend/scripts/oci-vm-setup.sh).

### 🚀 Execution

Clone the repository onto the VM and execute:

```bash
chmod +x scripts/oci-vm-setup.sh
sudo ./scripts/oci-vm-setup.sh
```

### ⚙️ What the Setup Script Performs

1.  **OS Detection**: Automatically determines if the OS is Debian/Ubuntu or RedHat/Oracle Linux.
2.  **Redis System Tuning**: Applies `sysctl` rules to enable `vm.overcommit_memory = 1` which prevents background save failures in low-memory settings.
3.  **Docker Installation**: Installs the Docker Engine and Docker Compose V2.
4.  **Local Firewall Rules**:
    *   **Ubuntu (iptables)**: Inserts rule accept declarations *before* the catch-all `REJECT` rule (usually at index 5).
    *   **Oracle Linux (firewalld)**: Appends HTTP/HTTPS services to the public zone and reloads rules.

---

## 🔌 Phase 3: Nginx Reverse Proxy Setup (Object Storage Proxy Mode)

Instead of serving the built frontend assets from the VM local drive, Nginx is configured to reverse-proxy traffic to your OCI Object Storage bucket. This allows Single Page Application (SPA) routing routes to be handled correctly and caches assets locally.

We have created the configuration script: [setup-nginx.sh](file:///d:/Vibe/node-backend/scripts/setup-nginx.sh).

### 🚀 Execution

Run the script by providing the OCI region, namespace, and bucket name:

```bash
# Set variables and execute
export OCI_REGION="us-ashburn-1"
export OCI_NAMESPACE="your_tenancy_namespace"
export OCI_BUCKET="your_bucket_name"

chmod +x scripts/setup-nginx.sh
sudo -E ./scripts/setup-nginx.sh
```

### 📄 Nginx Proxy Logic (SPA Routing Fallback)

The proxy server block handles the SPA client-side routing and static files as follows:

*   **Static Assets (Regex Check)**: If the URI ends in an asset extension (like `.js`, `.css`, `.wasm`, `.png`), Nginx rewrites the path to `/n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o/` + file name, and proxies to OCI Object Storage.
*   **SPA Client Routes**: If the URI does not have a file extension (e.g. `/play`, `/home`, or root `/`), Nginx rewrites the path to serve `/n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o/index.html`. This enables Flutter routing libraries to handle routing locally.
*   **Asset Caching**: Assets are cached using `proxy_cache_valid 200 60m` to optimize delivery times and minimize OCI Object Storage outbound data transfer costs.
*   **REST Requests (`/api/`)**: Proxied to local port `3000`.
*   **WebSocket Engine (`/socket.io/`)**: Proxied to local port `3000` with the `Upgrade` headers enabled.

---

## 🔒 Phase 4: SSL/TLS with Let's Encrypt

To transition from plain HTTP (`http://`) to secure HTTPS/WSS (`https://` and `wss://`), use **Certbot** to acquire a free Let's Encrypt certificate.

### 📝 Step-by-step SSL Provisioning

1.  Ensure you have a domain or dynamic DNS mapped to your VM's public IP address (e.g., `cricket-manager.duckdns.org` pointing to your VM IP).
2.  Install Certbot and Nginx plugin:
    ```bash
    # Ubuntu/Debian
    sudo apt-get install -y certbot python3-certbot-nginx
    
    # Oracle Linux/RHEL
    sudo dnf install -y certbot python3-certbot-nginx
    ```
3.  Generate the certificate:
    ```bash
    sudo certbot --nginx -d cricket-manager.duckdns.org
    ```
4.  Follow the prompts to enter your email and agree to terms. Certbot will verify the domain challenge and automatically modify your Nginx block to handle SSL redirect and certificates.
5.  Test certificate renewal:
    ```bash
    sudo certbot renew --dry-run
    ```

---

## 🐳 Phase 5: Docker Compose Deployment (Backend & Redis Only)

Since the frontend is served out of Object Storage, the compute instance only hosts the backend Node.js app and Redis.

### 📄 `docker-compose.yml`

Create a production compose file in your deployment folder:

```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    container_name: cricket-redis
    restart: always
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    expose:
      - "6379"

  backend:
    image: node-backend:latest
    container_name: cricket-backend
    restart: always
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - NODE_ENV=production
      - PORT=3000
      - REDIS_URL=redis://redis:6379
      - SUPABASE_URL=https://your-supabase-url.supabase.co
      - SUPABASE_KEY=your-supabase-anon-key
      - JWT_SECRET=your-secure-jwt-secret
    ports:
      - "127.0.0.1:3000:3000" # Expose only locally to force traffic through Nginx
    depends_on:
      - redis

volumes:
  redis_data:
```

### 🚀 Shell Deployment Commands

```bash
# Build and run containers in detached mode
docker compose up -d --build

# View container logs
docker compose logs -f
```

---

## 📦 Phase 6: OCI Object Storage & CI/CD Pipeline

To compile the Flutter web application and automatically sync it to OCI Object Storage on push events:

### 1. Configure the OCI Object Storage Bucket
1.  Log in to the **OCI Console**.
2.  Navigate to **Storage** -> **Object Storage & Archive Storage** -> **Buckets**.
3.  Click **Create Bucket**.
    *   **Name**: Set a name (e.g., `cricket-frontend`).
    *   **Storage Tier**: Standard.
4.  Once created, click on the bucket, click **Edit Visibility**, set it to **Public**, and save. This enables files to be downloaded publicly by Nginx.
5.  Note down the **Object Storage Namespace** shown in the Bucket Information panel.

### 2. Configure GitHub Repository Secrets
To allow the GitHub Actions runner to authenticate and sync files with your OCI bucket, add the following secrets in your GitHub repository under **Settings > Secrets and variables > Actions > Secrets**:

*   **`OCI_CLI_TENANCY`** (Tenancy OCID):
    *   *Where to get:* Click the Profile icon in the top right corner of the OCI Console -> Click on your **Tenancy: <name>** link (or search "Tenancy Details" in the search bar). Under **Tenancy Information**, copy the **OCID** string (starts with `ocid1.tenancy.oc1...`).
*   **`OCI_CLI_USER`** (User OCID):
    *   *Where to get:* Click the Profile icon in the top right corner of the OCI Console -> Click on your username (**My Profile** / **User Settings**). In the **User Details** page, copy the **OCID** string (starts with `ocid1.user.oc1...`).
*   **`OCI_CLI_REGION`**:
    *   *Where to get:* Look at the header bar of your OCI Console. In the top right, next to your profile icon, your current home/active region is shown (e.g., "US East (Ashburn)" or "UK South (London)"). Click it to see the region identifier code (e.g., `us-ashburn-1`, `uk-london-1`).
*   **`OCI_CLI_FINGERPRINT` & `OCI_PRIVATE_KEY`**:
    *   *How to generate & retrieve:*
        1. Navigate to your **User Details** page (Profile icon -> User Settings).
        2. On the bottom-left sidebar, under **Resources**, click **API Keys**.
        3. Click **Add API Key**.
        4. Select **Generate API Key Pair** and click **Download Private Key** to save the `.pem` file. Keep this secure.
        5. Click **Add**.
        6. A dialog box will display your configuration text containing the **Fingerprint** (looks like `2f:d5:12:xx:xx...`). Copy the fingerprint for `OCI_CLI_FINGERPRINT`.
        7. Open the downloaded `.pem` private key in a text editor and copy the entire block (including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`) to paste as `OCI_PRIVATE_KEY` in GitHub.
*   **`OCI_BUCKET_NAME`**:
    *   *Where to get:* In the OCI navigation menu, go to **Storage** -> **Buckets** (select the appropriate Compartment). Copy the exact name of the bucket you created (e.g., `cricket-frontend`).
*   **`OCI_NAMESPACE`**:
    *   *Where to get:* Open the bucket you created in the OCI Console. In the **Bucket Information** panel, copy the string under **Object Storage Namespace** (this is a short alphanumeric string, e.g., `ax3mq8yv9z8w`).

### 3. CI/CD Workflow (`.github/workflows/deploy.yml`)
The workflow is configured in the `cricket-ultimate-manager` repository at `.github/workflows/deploy.yml`. When changes are pushed to `main`/`master`, it:
1.  Sets up the stable Flutter channel.
2.  Resolves Flutter packages (`flutter pub get`).
3.  Builds the static application (`flutter build web --release`).
4.  Deploys the `build/web` directory content to OCI Object Storage using the OCI CLI, deleting stale files in the bucket using the `--delete` flag.

---

## 🧹 Phase 7: Removing Local VM Frontend Files

If you previously hosted the frontend files directly on the VM, you should remove them to free up disk space and avoid confusion:

```bash
# Remove built files from local path
sudo rm -rf /var/www/cricket-web/*

# Optional: Remove empty directory
sudo rmdir /var/www/cricket-web
```

---

## 🔍 Troubleshooting & Verification

### 1. Nginx Cache Purging
If you deploy updates to Object Storage but still see old content, bypass the Nginx cache or restart Nginx to clear dynamic memory buffers:
```bash
sudo systemctl restart nginx
```

### 2. Verify Port Binding
Ensure Nginx is listening on port 80/443 and routing to the backend correctly:
```bash
sudo netstat -tulpn | grep -E "80|443"
```
