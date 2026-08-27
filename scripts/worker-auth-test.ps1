# Substrate AUTH_OK test (Phase 0 gate).
# Usage: .\scripts\worker-auth-test.ps1 -Token <CLAUDE_CODE_OAUTH_TOKEN>
# Or set CLAUDE_CODE_OAUTH_TOKEN in the environment / .env first.
param([string]$Token = $env:CLAUDE_CODE_OAUTH_TOKEN)

if (-not $Token) {
  Write-Error "No token. Pass -Token or set CLAUDE_CODE_OAUTH_TOKEN."
  exit 2
}

Set-Location (Join-Path $PSScriptRoot "..")
docker compose --profile tools run --rm -e "CLAUDE_CODE_OAUTH_TOKEN=$Token" worker
exit $LASTEXITCODE
