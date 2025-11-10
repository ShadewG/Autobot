#!/bin/bash

# Portal Agent Test Runner
# Double-click this file to run the portal automation test

echo "🚀 Portal Agent Test Runner"
echo "================================"
echo ""

# Navigate to the project directory
cd "$(dirname "$0")"
echo "📁 Working directory: $(pwd)"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed!"
    echo "   Please install Node.js from https://nodejs.org/"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

echo "✅ Node.js found: $(node --version)"
echo "✅ npm found: $(npm --version)"
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Load environment variables from .env file if it exists
if [ -f ".env" ]; then
    echo "📄 Loading environment variables from .env file..."
    export $(grep -v '^#' .env | xargs)
else
    echo "⚠️  Warning: .env file not found"
    echo "   Please create a .env file with:"
    echo "   ANTHROPIC_API_KEY=your-key-here"
    echo "   REQUESTS_INBOX=requests@foib-request.com"
    echo ""
fi

# Check if required env vars are set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ Error: ANTHROPIC_API_KEY not set!"
    echo "   Please add it to your .env file or export it:"
    echo "   export ANTHROPIC_API_KEY='your-key-here'"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

if [ -z "$REQUESTS_INBOX" ]; then
    echo "⚠️  Warning: REQUESTS_INBOX not set, using default"
    export REQUESTS_INBOX="requests@foib-request.com"
fi

echo "🔑 Environment variables loaded"
echo "   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:20}..."
echo "   REQUESTS_INBOX: $REQUESTS_INBOX"
echo ""

# Portal URL
PORTAL_URL="https://colliercountyshofl.govqa.us/WEBAPP/_rs/(S(40bmt2z4fqa2vj4qjeprylkk))/RequestLogin.aspx?sSessionID=&rqst=4&target=ZwpfxNlipoMF2Ut+o/ukfVBzG+KwiVYui6tQ4jBaoyEbXnRUsppuaM9gxkGUAiqmY6bx2x6s+8GPrd0Llw+EPhizz6Hs8jVNfkAsIs+6AqFfxaZ3pTScuE+r1HIM68Lo"

echo "🌐 Portal URL: Collier County GovQA Portal"
echo ""
echo "🤖 Starting portal agent test..."
echo "💡 A browser window will open - watch the AI work!"
echo ""
echo "================================"
echo ""

# Run the test
node test-portal-agent.js "$PORTAL_URL"

# Capture exit code
EXIT_CODE=$?

echo ""
echo "================================"
echo ""

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Test completed successfully!"
    echo ""
    echo "📸 Screenshots saved to:"
    echo "   ./portal-screenshots/"
    echo "   ./portal-agent-result.png"
    echo ""
    echo "📝 Detailed log saved to:"
    echo "   ./portal-agent-log.json"
    echo ""

    # Open screenshots folder
    if [ -d "portal-screenshots" ]; then
        echo "📂 Opening screenshots folder..."
        open portal-screenshots/

        # Also open final screenshot
        if [ -f "portal-agent-result.png" ]; then
            open portal-agent-result.png
        fi
    fi
else
    echo "❌ Test failed with exit code $EXIT_CODE"
    echo "   Check the error messages above"
fi

echo ""
read -p "Press Enter to close..."
