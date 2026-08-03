@echo off
setlocal
cd /d "%~dp0"

if not exist ".edge-tts-venv\Scripts\python.exe" (
  echo [Edge TTS] Creating local Python environment...
  python -m venv .edge-tts-venv
  if errorlevel 1 goto :error
)

.edge-tts-venv\Scripts\python.exe -B -c "import edge_tts" >nul 2>&1
if errorlevel 1 (
  echo [Edge TTS] Installing required package for the first time...
  .edge-tts-venv\Scripts\python.exe -B -m pip install -r requirements-edge-tts.txt
  if errorlevel 1 goto :error
)

echo [Edge TTS] Starting at http://127.0.0.1:8765
.edge-tts-venv\Scripts\python.exe -u -B edge_tts_service.py
if errorlevel 1 goto :error
goto :eof

:error
echo.
echo [Edge TTS] Startup failed. Please copy the error above and send it to Codex.
pause
exit /b 1
