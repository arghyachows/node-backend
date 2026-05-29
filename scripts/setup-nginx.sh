#!/usr/bin/env bash

# 🏏 Cricket Ultimate Manager - Nginx Config Script (OCI Object Storage Integration)
# Configures Nginx to act as a reverse proxy for:
# 1. Frontend: Hosted in an OCI Object Storage public bucket (handling SPA routing fallbacks).
# 2. REST API & WebSockets: Running on the local Node.js backend.

set -euo pipefail

# Default values or env overrides
OCI_REGION="${OCI_REGION:-us-ashburn-1}"
OCI_NAMESPACE="${OCI_NAMESPACE:-your_tenancy_namespace}"
OCI_BUCKET="${OCI_BUCKET:-your_bucket_name}"

echo "================================================================"
echo "Configuring Nginx on OCI VM (Object Storage Proxy Mode)"
echo "================================================================"
echo "Configured parameters:"
echo " - OCI Region: $OCI_REGION"
echo " - OCI Namespace: $OCI_NAMESPACE"
echo " - OCI Bucket: $OCI_BUCKET"
echo "================================================================"

# Ensure Nginx is running
sudo systemctl enable nginx || true
sudo systemctl start nginx || true

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS="unknown"
fi

NGINX_CONF=""
NGINX_LINK=""
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    NGINX_CONF="/etc/nginx/sites-available/cricket-backend"
    NGINX_LINK="/etc/nginx/sites-enabled/cricket-backend"
else
    NGINX_CONF="/etc/nginx/conf.d/cricket-backend.conf"
    NGINX_LINK=""
fi

echo "Writing Nginx configuration to $NGINX_CONF..."

sudo tee "$NGINX_CONF" > /dev/null << EOF
# Map rewritten URIs to correct Content-Types since OCI Object Storage can serve them as application/octet-stream
map \$uri \$custom_content_type {
    default                    "application/octet-stream";
    ~*\\.html\$                  "text/html";
    ~*\\.css\$                   "text/css";
    ~*\\.js\$                    "application/javascript";
    ~*\\.wasm\$                  "application/wasm";
    ~*\\.png\$                   "image/png";
    ~*\\.jpg\$                   "image/jpeg";
    ~*\\.jpeg\$                  "image/jpeg";
    ~*\\.gif\$                   "image/gif";
    ~*\\.svg\$                   "image/svg+xml";
    ~*\\.ico\$                   "image/x-icon";
    ~*\\.json\$                  "application/json";
}

server {
    listen 80;
    server_name _;

    # Serve frontend from OCI Object Storage Bucket
    location / {
        # Check if the requested file has a static asset extension
        set \$is_static 0;
        if (\$uri ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|json|wasm)$) {
            set \$is_static 1;
        }

        # For static assets, proxy to /o/<path>
        if (\$is_static = 1) {
            rewrite ^(.*)$ /n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o\$1 break;
        }

        # For SPA routes (non-static), proxy to /o/index.html
        if (\$is_static = 0) {
            rewrite ^(.*)$ /n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o/index.html break;
        }

        proxy_pass https://objectstorage.${OCI_REGION}.oraclecloud.com;
        proxy_set_header Host objectstorage.${OCI_REGION}.oraclecloud.com;
        proxy_ssl_server_name on;
        
        # Override Content-Type header with the mapped type
        proxy_hide_header Content-Type;
        add_header Content-Type \$custom_content_type;
        
        # Cache static assets locally on the VM to speed up loads and reduce egress costs
        proxy_cache_valid 200 60m;
        add_header X-Cache-Status \$upstream_cache_status;
    }

    # Proxy REST API requests to backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Proxy Socket.IO WebSockets to backend
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF

# Enable configuration if on Ubuntu/Debian
if [ -n "$NGINX_LINK" ]; then
    sudo ln -sf "$NGINX_CONF" "$NGINX_LINK"
    # Remove default site if it exists
    sudo rm -f /etc/nginx/sites-enabled/default || true
fi

# Reload Nginx
echo "Testing Nginx configuration..."
sudo nginx -t

echo "Reloading Nginx..."
sudo systemctl reload nginx || sudo systemctl restart nginx

echo "Nginx configuration completed successfully in Object Storage proxy mode!"
