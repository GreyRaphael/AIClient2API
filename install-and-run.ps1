# install-and-run.ps1
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AI Client 2 API Quick Setup Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Handle parameters
$forcePull = $args -contains "--pull"

# Check Git and Pull
if ($forcePull) {
    Write-Host "[UPDATE] Pulling latest code from remote repository..."
    if (Get-Command git -ErrorAction SilentlyContinue) {
        git pull
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Git pull failed. Please check your network or handle conflicts manually."
        } else {
            Write-Host "[SUCCESS] Code updated." -ForegroundColor Green
        }
    } else {
        Write-Warning "Git not detected. Skipping code pull."
    }
}

# Check Node.js
Write-Host "[CHECK] Checking if Node.js is installed..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js not detected. Please install Node.js (https://nodejs.org/)" -ForegroundColor Red
    Pause
    exit 1
}

$nodeVersion = node --version
Write-Host "[SUCCESS] Node.js installed, version: $nodeVersion" -ForegroundColor Green

# Check native TypeScript support (Node.js >= 22.18.0)
Write-Host "[CHECK] Checking native TypeScript support..." -ForegroundColor Cyan
node -e "if (!process.features || !process.features.typescript) process.exit(1)"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Current Node.js ($nodeVersion) does not support native TypeScript execution." -ForegroundColor Red
    Write-Host "Please upgrade to Node.js >= 22.18.0 (Node 22 LTS or 24)."
    Write-Host "Download: https://nodejs.org/"
    Pause
    exit 1
}
Write-Host "[SUCCESS] Native TypeScript execution is supported." -ForegroundColor Green

# Check package.json
if (-not (Test-Path "package.json")) {
    Write-Host "[ERROR] package.json not found. Please ensure you are running this script from the project root." -ForegroundColor Red
    Pause
    exit 1
}

Write-Host "[INSTALL] Installing/updating dependencies using npm..." -ForegroundColor Cyan

& npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Dependency installation failed. Please check your network connection." -ForegroundColor Red
    Pause
    exit 1
}

# Check master file
if (-not (Test-Path "src\core\master.js")) {
    Write-Host "[ERROR] src\core\master.js not found." -ForegroundColor Red
    Pause
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Starting AIClient2API Server..." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Server will start at http://localhost:3000"
Write-Host "Press Ctrl+C to stop the server"
Write-Host ""

node src\core\master.js
