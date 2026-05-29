#!/usr/bin/env bash

# 🏏 Cricket Ultimate Manager - OCI VM Setup Script
# Automatically configures an Oracle Cloud VM (Ubuntu or Oracle Linux/RHEL) to host the node-backend
# with Docker, Redis, Nginx reverse proxy, and SSL support.

set -e

# Visual Banners
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================================${NC}"
echo -e "${BLUE}🏏 Cricket Ultimate Manager - OCI VM Setup Script${NC}"
echo -e "${BLUE}====================================================================${NC}"

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS=$(uname -s)
fi

echo -e "Detected OS: ${GREEN}$OS${NC}"

# Configure memory overcommit for Redis
echo -e "${YELLOW}Configuring Redis memory overcommit settings...${NC}"
sudo sysctl vm.overcommit_memory=1 || true
if ! grep -q "vm.overcommit_memory = 1" /etc/sysctl.conf; then
    echo "vm.overcommit_memory = 1" | sudo tee -a /etc/sysctl.conf
fi
echo -e "Redis memory overcommit: ${GREEN}Enabled${NC}"

# Handle package installations and firewalls based on OS
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    echo -e "${YELLOW}Configuring Ubuntu/Debian system...${NC}"
    
    # Non-blocking apt locks check
    sudo systemctl stop unattended-upgrades || true
    sudo killall apt apt-get 2>/dev/null || true
    sudo dpkg --configure -a
    
    # Install dependencies
    sudo apt-get update || true
    sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release iptables-persistent nginx apache2-utils

    # Install Docker & Docker Compose V2
    echo -e "${YELLOW}Installing Docker and Docker Compose...${NC}"
    sudo apt-get install -y docker.io docker-compose-v2 || true
    sudo systemctl start docker || true
    sudo systemctl enable docker || true

    # Configure Firewall (iptables for Ubuntu in OCI)
    echo -e "${YELLOW}Configuring Firewall (iptables)...${NC}"
    # OCI Ubuntu has a default REJECT rule at line 5. We insert before it.
    sudo iptables -I INPUT 5 -p tcp --dport 80 -m state --state NEW -j ACCEPT || true
    sudo iptables -I INPUT 5 -p tcp --dport 443 -m state --state NEW -j ACCEPT || true
    sudo iptables -I INPUT 5 -p tcp --dport 3000 -m state --state NEW -j ACCEPT || true
    
    # Save the iptables rules
    sudo netfilter-persistent save || true

elif [ "$OS" = "ol" ] || [ "$OS" = "rhel" ] || [ "$OS" = "centos" ]; then
    echo -e "${YELLOW}Configuring Oracle Linux/RedHat system...${NC}"
    
    # Install dependencies
    sudo dnf install -y curl gnupg2 nginx firewalld iptables-services

    # Enable and start Firewall
    sudo systemctl enable firewalld || true
    sudo systemctl start firewalld || true

    # Configure Firewall
    echo -e "${YELLOW}Configuring Firewall (firewalld)...${NC}"
    sudo firewall-cmd --permanent --add-service=http || true
    sudo firewall-cmd --permanent --add-service=https || true
    sudo firewall-cmd --permanent --add-port=3000/tcp || true
    sudo firewall-cmd --reload || true

    # Install Docker & Compose V2
    echo -e "${YELLOW}Installing Docker and Docker Compose...${NC}"
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || true
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin || true
    sudo systemctl start docker || true
    sudo systemctl enable docker || true

else
    echo -e "${RED}Unsupported OS: $OS. Please install Docker, Nginx, and open ports 80/443 manually.${NC}"
    exit 1
fi

# Verify Docker installation
if command -v docker &> /dev/null; then
    echo -e "Docker Version: ${GREEN}$(docker --version)${NC}"
else
    echo -e "${RED}Docker installation failed or needs manual config.${NC}"
fi

echo -e "${GREEN}Basic system packages, Docker, Nginx, and firewalls are set up!${NC}"