#!/bin/bash

echo "🚀 Portal AgentKit Test Runner"
echo "================================"
echo

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

echo "📁 Working directory: $ROOT_DIR"
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm not found"; exit 1; }

if [ -f ".env" ]; then
  echo "📄 Loading environment variables from .env..."
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "⚠️  .env not found. Create one with OPENAI_API_KEY and OPENAI_PORTAL_AUTOMATION_ID."
fi

if [ -z "$OPENAI_API_KEY" ]; then
  read -p "OpenAI API Key (sk-…): " OPENAI_API_KEY
fi

if [ -z "$OPENAI_PORTAL_AUTOMATION_ID" ]; then
  read -p "OpenAI Portal Automation ID (auto_…): " OPENAI_PORTAL_AUTOMATION_ID
fi

DEFAULT_PORTAL_URL="https://colliercountyshofl.govqa.us/WEBAPP/_rs/(S(40bmt2z4fqa2vj4qjeprylkk))/RequestLogin.aspx?sSessionID=&rqst=4&target=ZwpfxNlipoMF2Ut+o/ukfVBzG+KwiVYui6tQ4jBaoyEbXnRUsppuaM9gxkGUAiqmY6bx2x6s+8GPrd0Llw+EPhizz6Hs8jVNfkAsIs+6AqFfxaZ3pTScuE+r1HIM68Lo"
read -p "Portal URL [Enter for Collier County GovQA]: " PORTAL_URL
PORTAL_URL=${PORTAL_URL:-$DEFAULT_PORTAL_URL}
if [ -z "$PORTAL_URL" ]; then
  echo "❌ Portal URL required."
  exit 1
fi

read -p "Case ID (optional): " CASE_ID

CMD="node test-portal-agentkit.js \"$PORTAL_URL\""
if [ -n "$CASE_ID" ]; then
  CMD="$CMD \"$CASE_ID\""
fi

echo
echo "🤖 Running AgentKit automation..."
eval $CMD
