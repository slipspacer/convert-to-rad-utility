@echo off
rem Double-click to start the RAD Converter and open it in your browser.
rem Keep this window open while you use it; close it (or press Ctrl+C) to stop.
rem Pass --no-browser to only start the server.
setlocal
title RAD Converter
cd /d "%~dp0"

rem Find Python 3: the "py" launcher first, then "python". The Microsoft Store
rem "python" alias only offers an install, so check that it actually runs.
set "PY="
py -3 -c "pass" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "pass" >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python 3 is needed to serve the converter locally.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

rem Use 8090, or the next free port if something else is already on it.
set PORT=8090
:findport
netstat -ano -p tcp | findstr /r /c:":%PORT% .*LISTENING" >nul && (set /a PORT+=1 & goto findport)
set "URL=http://localhost:%PORT%"

echo RAD Converter running at %URL%
echo Leave this window open while you use it. Close it or press Ctrl+C to stop.
echo.

rem Choosing a save folder needs a Chromium browser, so prefer Chrome or Edge.
if /i "%~1"=="--no-browser" goto serve
set "OPENER="
for %%B in (chrome msedge) do (
  if not defined OPENER (
    reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B.exe" >nul 2>&1 && set "OPENER=%%B"
    reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B.exe" >nul 2>&1 && set "OPENER=%%B"
  )
)
rem Open the browser after a short delay so the server is listening first.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start %OPENER% %URL%"

:serve
%PY% serve.py --port %PORT%
if errorlevel 1 (
  echo.
  echo The server stopped with an error.
  pause
)
