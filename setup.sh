#!/bin/bash

echo "🏏 Cricket Match Simulation Backend - Quick Start"
echo "=================================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 20+"
    exit 1
fi

echo "✅ Node.js $(node --version) found"

# Check Redis
if ! command -v redis-cli &> /dev/null; then
    echo "❌ Redis not found. Installing..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        brew install redis
        brew services start redis
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        sudo apt update
        sudo apt install -y redis-server
        sudo systemctl start redis
    else
        echo "Please install Redis manually"
        exit 1
    fi
fi

# Test Redis
if redis-cli ping &> /dev/null; then
    echo "✅ Redis is running"
else
    echo "❌ Redis is not running. Starting..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew services start redis
    else
        sudo systemctl start redis
    fi
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Setup environment
if [ ! -f .env ]; then
    echo ""
    echo "⚙️  Creating .env file..."
    cp .env.example .env
    echo "✅ .env created. Please edit with your credentials."
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your Supabase credentials"
echo "2. Run: npm start"
echo "3. Test: curl http://localhost:3000/health"
echo ""
