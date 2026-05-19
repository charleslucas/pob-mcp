# InstallTcpApi.ps1
# Installs the PoB TCP API server into the standard PoB Community installation.
# Run from the pob-mcp directory:  .\InstallTcpApi.ps1
#
# What it does:
#   1. Creates an API\ folder in the PoB Community installation directory
#   2. Copies API\TcpServer.lua, API\Handlers.lua, API\BuildOps.lua
#   3. Patches Modules\Main.lua to start the TCP server when POB_API_TCP=1
#
# Safe to re-run after PoB updates — re-applies only what changed.
# LaunchPoBWithAPI.bat calls this automatically on every launch so you
# never have to think about it after an update.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Locate PoB Community installation ────────────────────────────────────────
$pobDir = "$env:APPDATA\Path of Building Community"
if (-not (Test-Path $pobDir)) {
    Write-Error "Path of Building Community not found at: $pobDir"
    exit 1
}
Write-Host "PoB installation: $pobDir" -ForegroundColor Cyan

# ── Locate source files (relative to this script) ────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$forkApiDir = Join-Path $scriptDir "..\PathOfBuilding\src\API"
if (-not (Test-Path $forkApiDir)) {
    # Fall back: look for PathOfBuilding next to pob-mcp
    $forkApiDir = Join-Path $scriptDir "..\..\PathOfBuilding\src\API"
}
if (-not (Test-Path $forkApiDir)) {
    Write-Error "Cannot find the PathOfBuilding fork API directory. Expected at: $forkApiDir`nClone https://github.com/charleslucas/PathOfBuilding (api-stdio branch) next to pob-mcp."
    exit 1
}
$forkApiDir = Resolve-Path $forkApiDir
Write-Host "Source API dir:   $forkApiDir" -ForegroundColor Cyan

# ── Step 1: Create API directory ─────────────────────────────────────────────
$destApiDir = Join-Path $pobDir "API"
if (-not (Test-Path $destApiDir)) {
    New-Item -ItemType Directory -Path $destApiDir | Out-Null
    Write-Host "[1/3] Created $destApiDir" -ForegroundColor Green
} else {
    Write-Host "[1/3] API directory already exists" -ForegroundColor Yellow
}

# ── Step 2: Copy Lua API files ────────────────────────────────────────────────
$filesToCopy = @("TcpServer.lua", "Handlers.lua", "BuildOps.lua")
foreach ($file in $filesToCopy) {
    $src = Join-Path $forkApiDir $file
    $dst = Join-Path $destApiDir $file
    if (-not (Test-Path $src)) {
        Write-Error "Source file missing: $src"
        exit 1
    }
    Copy-Item -Path $src -Destination $dst -Force
    Write-Host "[2/3] Copied $file" -ForegroundColor Green
}

# ── Step 3: Patch Modules\Main.lua ───────────────────────────────────────────
$mainLua = Join-Path $pobDir "Modules\Main.lua"
if (-not (Test-Path $mainLua)) {
    Write-Error "Main.lua not found at: $mainLua"
    exit 1
}

$content = Get-Content -Path $mainLua -Raw -Encoding UTF8
$patchTag    = "-- [pob-mcp TCP API patch]"
$insertBefore = "function main:DetectUnicodeSupport()"

if ($content -match [regex]::Escape($patchTag)) {
    Write-Host "[3/3] Main.lua already patched — skipping" -ForegroundColor Yellow
} elseif ($content -notmatch [regex]::Escape($insertBefore)) {
    Write-Error "Could not find '$insertBefore' in Main.lua — PoB version may be incompatible."
    exit 1
} else {
    # Back up the original
    $backup = $mainLua + ".bak"
    if (-not (Test-Path $backup)) {
        Copy-Item -Path $mainLua -Destination $backup
        Write-Host "[3/3] Backed up Main.lua -> Main.lua.bak" -ForegroundColor Cyan
    }

    # The TCP block is inserted just before the closing `end` of main:Init() so that
    # `self` (the main object) is in scope for self.onFrameFuncs.
    # We locate that end by finding the blank line + DetectUnicodeSupport boundary,
    # then replace the `end\n\n` just before it with `end + our block + \n\n`.
    #
    # Single-quoted here-string: PowerShell will NOT interpolate $-variables inside,
    # so Lua code is preserved verbatim.
    $tcpBlock = @'
	-- [pob-mcp TCP API patch]
	-- Start the TCP API server when POB_API_TCP=1 (set by LaunchPoBWithAPI.bat).
	-- Pumped via onFrameFuncs each GUI frame so it never blocks the UI.
	if os.getenv('POB_API_TCP') == '1' then
		local tcpPort = tonumber(os.getenv('POB_API_TCP_PORT')) or 31337
		local apiBase = (GetScriptPath and GetScriptPath()) or '.'
		local ok_h, API
		ok_h, API = pcall(dofile, apiBase .. '/API/Handlers.lua')
		if not (ok_h and API) then ok_h, API = pcall(require, 'API.Handlers') end
		if ok_h and API then
			local ok_t, TcpServer
			ok_t, TcpServer = pcall(dofile, apiBase .. '/API/TcpServer.lua')
			if not (ok_t and TcpServer) then ok_t, TcpServer = pcall(require, 'API.TcpServer') end
			if ok_t and TcpServer and TcpServer.available then
				if TcpServer.init(API.handlers, tcpPort) then
					self.onFrameFuncs['TcpServer'] = function() TcpServer.pump() end
					ConPrintf('[PoB API] TCP server started on port %d', tcpPort)
					-- Hide the "Update Ready" button while the TCP API is active.
					-- Clicking it mid-session would replace Main.lua and break the connection.
					-- Users who want to update should close PoB and relaunch without the batch file.
					if self.controls and self.controls.applyUpdate then
						self.controls.applyUpdate.shown = function() return false end
					end
				end
			else
				ConPrintf('[PoB API] TcpServer unavailable: %s', tostring(TcpServer))
			end
		else
			ConPrintf('[PoB API] Could not load API.Handlers: %s', tostring(API))
		end
	end

'@

    # Insert our block before the `end` that closes Init().
    # Pattern: `end` on its own line followed by blank line(s) then DetectUnicodeSupport.
    # We keep the `end` in place and inject inside it.
    # Insert BEFORE the bare `end` that closes Init(), so our code is inside Init()
    # and `self` is in scope. The block must come before `end`, not after.
    $patched = $content -replace `
        '(?m)^end(\r?\n[\r\n]*)(function main:DetectUnicodeSupport\(\))', `
        ($tcpBlock + 'end$1$2')

    if ($patched -eq $content) {
        # Simpler fallback: just insert before DetectUnicodeSupport
        $patched = $content.Replace($insertBefore, ($tcpBlock + $insertBefore))
    }

    Set-Content -Path $mainLua -Value $patched -Encoding UTF8 -NoNewline
    Write-Host "[3/3] Patched Main.lua (TCP block inserted inside Init())" -ForegroundColor Green
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "To use TCP mode:"
Write-Host "  1. Launch PoB using LaunchPoBWithAPI.bat (or with POB_API_TCP=1 set)"
Write-Host "  2. Open a build in PoB"
Write-Host "  3. Set POB_API_TCP=true in your Claude Desktop config"
Write-Host "  4. Use any lua_* tool in Claude to connect"
Write-Host ""
Write-Host "If PoB updates and removes the patch, just run this script again."
Write-Host ""
Write-Host "WARNING: If you use the 'Check for Updates' / 'Update' button inside PoB," -ForegroundColor Yellow
Write-Host "         the update will overwrite Main.lua and the TCP server will stop" -ForegroundColor Yellow
Write-Host "         working on the NEXT launch. LaunchPoBWithAPI.bat will detect this" -ForegroundColor Yellow
Write-Host "         and automatically re-apply the patch, so just relaunch via the" -ForegroundColor Yellow
Write-Host "         batch file and it will self-heal." -ForegroundColor Yellow
