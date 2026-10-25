@echo off
set PROFILE=%~1
if "%PROFILE%"=="" set PROFILE=%TEMP%\stash-shot-profile
set PORT=%~2
if "%PORT%"=="" set PORT=9333
if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=%PORT% --user-data-dir=%PROFILE% --no-first-run --no-default-browser-check --window-size=1600,1000 --window-position=80,40 http://localhost:9999/
echo Chrome launched on port %PORT%, profile: %PROFILE%
