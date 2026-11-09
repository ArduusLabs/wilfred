@echo off
rem Starts Wilfred in the background (no console window). Running it again brings Wilfred back.
rem Electron fetches its program on first use rather than at npm install: fetch it now if missing.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  if not exist "%~dp0node_modules\electron\install.js" (echo Wilfred: run "npm install" in this folder first. & pause & exit /b 1)
  node "%~dp0node_modules\electron\install.js" || (echo Wilfred: Electron's program could not be fetched. & pause & exit /b 1)
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
