@echo off
rem Obezlichivatel (local edition, no Claude). With Python: deep check via local Ollama.
rem Without Python: opens the page (fast check). Installs nothing.
cd /d "%~dp0"
py -3 -c "import sys" >nul 2>nul && (start "" pyw -3 local_server.py & exit /b)
python -c "import sys" >nul 2>nul && (start "" pythonw local_server.py & exit /b)
for %%f in ("%~dp0*.html") do start "" "%%f"
