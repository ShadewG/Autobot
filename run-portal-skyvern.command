#!/bin/bash

# Skyvern AI Portal Agent Test Runner
# Double-click this file to run portal automation with Skyvern AI

echo "🚀 Skyvern AI Portal Agent Test Runner"
echo "=========================================="
echo ""
echo "💡 Using Skyvern - AI-powered browser automation"
echo "   Open-source | Vision + LLM | Works on any website"
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

# Install axios if not present
if ! npm list axios &> /dev/null; then
    echo "📦 Installing axios..."
    npm install axios
    echo ""
fi

# Load environment variables from .env file if it exists
if [ -f ".env" ]; then
    echo "📄 Loading environment variables from .env file..."
    export $(grep -v '^#' .env | xargs)
else
    echo "⚠️  Warning: .env file not found"
    echo "   Please create a .env file with:"
    echo "   SKYVERN_API_KEY=your-key-here"
    echo "   REQUESTS_INBOX=requests@foib-request.com"
    echo ""
fi

# Check if required env vars are set
if [ -z "$SKYVERN_API_KEY" ]; then
    echo "❌ Error: SKYVERN_API_KEY not set!"
    echo ""
    echo "   To get your API key:"
    echo "   1. Go to https://app.skyvern.com"
    echo "   2. Sign up or log in"
    echo "   3. Go to Settings"
    echo "   4. Reveal your API key"
    echo "   5. Add it to your .env file:"
    echo "      SKYVERN_API_KEY=sk-..."
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

if [ -z "$REQUESTS_INBOX" ]; then
    echo "⚠️  Warning: REQUESTS_INBOX not set, using default"
    export REQUESTS_INBOX="requests@foib-request.com"
fi

echo "🔑 Environment variables loaded"
echo "   SKYVERN_API_KEY: ${SKYVERN_API_KEY:0:20}..."
echo "   REQUESTS_INBOX: $REQUESTS_INBOX"
echo ""

# Portal URL
PORTAL_URL="https://colliercountyshofl.govqa.us/WEBAPP/_rs/(S(40bmt2z4fqa2vj4qjeprylkk))/RequestLogin.aspx?sSessionID=&rqst=4&target=ZwpfxNlipoMF2Ut+o/ukfVBzG+KwiVYui6tQ4jBaoyEbXnRUsppuaM9gxkGUAiqmY6bx2x6s+8GPrd0Llw+EPhizz6Hs8jVNfkAsIs+6AqFfxaZ3pTScuE+r1HIM68Lo"

echo "🌐 Portal URL: Collier County GovQA Portal"
echo "🤖 Using: Skyvern AI (Open Source)"
echo "🧠 Engine: Skyvern 2.0 (85.85% WebVoyager benchmark)"
echo ""
echo "🤖 Starting agent..."
echo "💡 Skyvern will use AI vision + LLM to complete the task!"
echo ""
echo "=========================================="
echo ""

# Run the test
node test-portal-skyvern.js "$PORTAL_URL"

# Capture exit code
EXIT_CODE=$?

echo ""
echo "=========================================="
echo ""

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Test completed!"
    echo ""
    echo "📝 Log saved to:"
    echo "   ./portal-agent-skyvern-log.json"
    echo ""
    echo "💡 Check the log for the recording URL to watch what Skyvern did!"
    echo ""

    # Open log file
    if [ -f "portal-agent-skyvern-log.json" ]; then
        echo "📂 Opening log file..."
        open portal-agent-skyvern-log.json
    fi
else
    echo "❌ Test failed with exit code $EXIT_CODE"
    echo "   Check the error messages above"
fi

echo ""
read -p "Press Enter to close..."
