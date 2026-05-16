# UninstallTcpApi.ps1
# Removes the PoB TCP API server from the standard PoB Community installation.
# Reverses everything InstallTcpApi.ps1 did:
#   1. Restores Modules\Main.lua from the .bak backup created during install
#   2. Removes the API Lua files we copied in
#   3. Removes the API\ directory if it is now empty
#   4. Removes the Main.lua.bak backup file

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pobDir   = "$env:APPDATA\Path of Building Community"
$mainLua  = Join-Path $pobDir "Modules\Main.lua"
$backup   = $mainLua + ".bak"
$apiDir   = Join-Path $pobDir "API"
$patchTag = "-- [pob-mcp TCP API patch]"

if (-not (Test-Path $pobDir)) {
    Write-Error "Path of Building Community not found at: $pobDir"
    exit 1
}
Write-Host "PoB installation: $pobDir" -ForegroundColor Cyan

# --- Step 1: Restore Main.lua ------------------------------------------------
if (Test-Path $backup) {
    Copy-Item -Path $backup -Destination $mainLua -Force
    Remove-Item -Path $backup -Force
    Write-Host "[1/3] Restored Main.lua from backup and removed Main.lua.bak" -ForegroundColor Green
} else {
    $content = Get-Content -Path $mainLua -Raw -Encoding UTF8
    if ($content.Contains($patchTag)) {
        Write-Host "[1/3] WARNING: Main.lua.bak not found." -ForegroundColor Yellow
        Write-Host "      The patch is present in Main.lua but cannot be auto-removed" -ForegroundColor Yellow
        Write-Host "      without the original backup." -ForegroundColor Yellow
        Write-Host "      Options:" -ForegroundColor Yellow
        Write-Host "        a) Run InstallTcpApi.ps1 once to create a fresh backup," -ForegroundColor Yellow
        Write-Host "           then run UninstallTcpApi.ps1 again." -ForegroundColor Yellow
        Write-Host "        b) Use PoB's built-in updater to restore Main.lua," -ForegroundColor Yellow
        Write-Host "           then run UninstallTcpApi.ps1 again." -ForegroundColor Yellow
    } else {
        Write-Host "[1/3] Main.lua is already clean (patch not present, no backup needed)" -ForegroundColor Yellow
    }
}

# --- Step 2: Remove our API files -------------------------------------------
$ourFiles = @("TcpServer.lua", "Handlers.lua", "BuildOps.lua")
if (Test-Path $apiDir) {
    $removed = 0
    foreach ($file in $ourFiles) {
        $path = Join-Path $apiDir $file
        if (Test-Path $path) {
            Remove-Item -Path $path -Force
            Write-Host "[2/3] Removed API\$file" -ForegroundColor Green
            $removed++
        }
    }
    if ($removed -eq 0) {
        Write-Host "[2/3] No API files to remove (already gone)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[2/3] API\ directory not present -- nothing to remove" -ForegroundColor Yellow
}

# --- Step 3: Remove API\ directory if now empty -----------------------------
if (Test-Path $apiDir) {
    $remaining = @(Get-ChildItem -Path $apiDir -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
        Remove-Item -Path $apiDir -Force
        Write-Host "[3/3] Removed empty API\ directory" -ForegroundColor Green
    } else {
        Write-Host "[3/3] API\ directory has other files -- leaving it in place:" -ForegroundColor Yellow
        foreach ($f in $remaining) {
            Write-Host "      $($f.Name)"
        }
    }
} else {
    Write-Host "[3/3] API\ directory already gone" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Uninstall complete. PoB is restored to its original state." -ForegroundColor Green
Write-Host "You can safely delete LaunchPoBWithAPI.bat, InstallTcpApi.ps1, and UninstallTcpApi.ps1."
