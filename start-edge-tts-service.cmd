@echo off
cd /d "%~dp0"
if not exist ".edge-tts-venv\Scripts\python.exe" (
  python -m venv .edge-tts-venv
)
.edge-tts-venv\Scripts\python.exe -m pip install -r requirements-edge-tts.txt
.edge-tts-venv\Scripts\python.exe edge_tts_service.py
