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

:: Verify the patch actually LANDED in Main.lua. The installer can report success
:: yet leave Main.lua unpatched (e.g. a stale copy of this batch pointing the
:: installer at a path that no longer exists, or a PoB update overwriting the
:: patch). A silent miss here is exactly what made TCP "randomly" stop working
:: after updates -- so fail loud instead of launching a dead API.
findstr /C:"pob-mcp TCP API patch" "%POB_DIR%\Modules\Main.lua" >nul 2>&1
if errorlevel 1 (
    echo.
    echo [LaunchPoBWithAPI] WARNING: TCP patch NOT detected in Main.lua after install.
    echo   PoB will launch WITHOUT the TCP API -- Claude will not connect.
    echo   Review the InstallTcpApi.ps1 output above, then relaunch via this batch file.
    echo.
    pause
) else (
    echo [LaunchPoBWithAPI] Verified: TCP patch present in Main.lua.
)

:launch
start "" "%POB_DIR%\Path of Building.exe"
