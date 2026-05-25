@echo off
:: LaunchPoBWithAPI.bat
:: Launches Path of Building Community with the TCP API server enabled.
:: Auto-patches Modules\Main.lua on each launch so PoB updates don't break things.

set POB_API_TCP=1
set POB_API_TCP_PORT=59166
set POB_DIR=%APPDATA%\Path of Building Community

:: Check that both the Main.lua patch AND the API Lua files are present.
:: Either can be missing independently: Main.lua is overwritten by PoB updates;
:: API files can be absent on a fresh machine before the first install.
set NEEDS_INSTALL=0
findstr /c:"[pob-mcp TCP API patch]" "%POB_DIR%\Modules\Main.lua" >nul 2>&1
if errorlevel 1 set NEEDS_INSTALL=1
if not exist "%POB_DIR%\API\TcpServer.lua" set NEEDS_INSTALL=1

if "%NEEDS_INSTALL%"=="1" (
    echo [LaunchPoBWithAPI] Install needed -- running InstallTcpApi.ps1...
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
    echo [LaunchPoBWithAPI] Patch applied successfully.
)

:launch
start "" "%POB_DIR%\Path of Building.exe"
