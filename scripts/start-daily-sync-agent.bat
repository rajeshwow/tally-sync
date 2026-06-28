@echo off
setlocal

cd /d "%~dp0.."

echo ==========================================
echo FlexLoud Tally Daily Sync Agent Starting
echo Folder: %CD%
echo ==========================================

if not exist "dist\daily-sync.runner.js" (
  echo Build not found. Running npm build...
  call npm run build
)

echo Starting daily sync runner...
node dist\daily-sync.runner.js

endlocal