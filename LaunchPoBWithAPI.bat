@echo off
:: LaunchPoBWithAPI.bat
:: Launches Path of Building Community with the TCP API server enabled.
:: Auto-patches Modules\Main.lua on each launch so PoB updates don't break things.

set POB_API_TCP=1
set POB_API_TCP_PORT=59166
set POB_DIR=%APPDATA%\Path of Building Community

:: Always re-copy the API Lua files so updates to BuildOps.lua / Handlers.lua
:: take effect on next launch without a separate manual install step.
echo [LaunchPoBWithAPI] Syncing API Lua files...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0InstallTcpApi.ps1"
if errorlevel 1 (
    echo.
    echo [LaunchPoBWithAPI] ERROR: Installation failed.
    echo   PoB will launch WITHOUT the TCP API -- Claude will not be able to connect.
    echo   Fix the error shown above, then relaunch via this batch file.
    echo.
    pause
    goto launch
)
echo [LaunchPoBWithAPI] API files up to date.

:launch
start "" "%POB_DIR%\Path of Building.exe"
