@echo off
:: LaunchPoBWithAPI.bat
:: Launches Path of Building Community with the TCP API server enabled.
:: Auto-patches Modules\Main.lua on each launch so PoB updates don't break things.

set POB_API_TCP=1
set POB_API_TCP_PORT=31337
set POB_DIR=%APPDATA%\Path of Building Community

:: Check if the patch is still in place; if not, re-run the install script
findstr /c:"[pob-mcp TCP API patch]" "%POB_DIR%\Modules\Main.lua" >nul 2>&1
if errorlevel 1 (
    echo [LaunchPoBWithAPI] Patch not found -- running InstallTcpApi.ps1...
    powershell.exe -ExecutionPolicy Bypass -File "%~dp0InstallTcpApi.ps1"
    if errorlevel 1 (
        echo [LaunchPoBWithAPI] Installation failed. Launching PoB without TCP API.
        goto launch
    )
    echo [LaunchPoBWithAPI] Patch applied successfully.
)

:launch
start "" "%POB_DIR%\Path of Building.exe"
