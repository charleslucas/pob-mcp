# Verify-PoBRuntime.ps1
# Checks that the PoB binaries we actually run (and the copy vendored in
# PathOfBuilding\runtime) are byte-identical to an official upstream release.
#
# Usage:
#   .\Verify-PoBRuntime.ps1                       # uses version from manifest.xml, downloads the release
#   .\Verify-PoBRuntime.ps1 -Version 2.68.1       # pin the release to compare against
#   .\Verify-PoBRuntime.ps1 -ZipPath C:\tmp\PathOfBuildingCommunity-Portable.zip   # reuse a local zip
#
# Exit code 0 = every binary matches, 1 = mismatch or missing file.

param(
    [string]$Version,
    [string]$ZipPath,
    [string]$InstallDir = "$env:APPDATA\Path of Building Community"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $InstallDir)) { Write-Error "PoB install not found: $InstallDir" }

if (-not $Version) {
    $manifest = Join-Path $InstallDir "manifest.xml"
    $Version = ([xml](Get-Content $manifest -Raw)).PoBVersion.Version.number
    Write-Host "Version from manifest.xml: $Version" -ForegroundColor Cyan
}

if (-not $ZipPath) {
    $ZipPath = Join-Path $env:TEMP "PathOfBuildingCommunity-Portable-$Version.zip"
    if (-not (Test-Path $ZipPath)) {
        $url = "https://github.com/PathOfBuildingCommunity/PathOfBuilding/releases/download/v$Version/PathOfBuildingCommunity-Portable.zip"
        Write-Host "Downloading $url (~600 MB, one-off)" -ForegroundColor Yellow
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $ZipPath
    }
}
Write-Host "Official archive: $ZipPath" -ForegroundColor Cyan

# Extract only top-level files (exe/dll/lua at the root of the zip).
$tmp = Join-Path $env:TEMP "pob-verify-$Version"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
    foreach ($e in $zip.Entries) {
        if ($e.Name -and $e.FullName -notmatch '/') {
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $tmp $e.Name), $true)
        }
    }
} finally { $zip.Dispose() }

$repoRuntime = Join-Path (Split-Path -Parent $PSScriptRoot) "PathOfBuilding\runtime"
$rows = @()
foreach ($f in Get-ChildItem $tmp -File | Where-Object { $_.Extension -in '.exe', '.dll' }) {
    $expected = (Get-FileHash $f.FullName -Algorithm SHA256).Hash

    $installedPath = Join-Path $InstallDir $f.Name
    $installed = if (Test-Path $installedPath) { (Get-FileHash $installedPath -Algorithm SHA256).Hash -eq $expected } else { $null }

    # The fork stores the exe with its upstream build placeholder name.
    $repoPath = Join-Path $repoRuntime ($f.Name -replace ' ', '{space}')
    $repo = if (Test-Path $repoPath) { (Get-FileHash $repoPath -Algorithm SHA256).Hash -eq $expected } else { $null }

    $rows += [pscustomobject]@{ File = $f.Name; Sha256 = $expected; Installed = $installed; RepoRuntime = $repo }
}

$rows | Format-Table File, Installed, RepoRuntime -AutoSize

$bad = $rows | Where-Object { $_.Installed -ne $true -or $_.RepoRuntime -ne $true }
if ($bad) {
    Write-Host "MISMATCH in $($bad.Count) file(s):" -ForegroundColor Red
    $bad | ForEach-Object { "  $($_.File)  installed=$($_.Installed)  repo=$($_.RepoRuntime)" }
    exit 1
}

Write-Host "OK: $($rows.Count)/$($rows.Count) binaries match official v$Version exactly." -ForegroundColor Green
exit 0
