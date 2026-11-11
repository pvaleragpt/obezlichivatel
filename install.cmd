@echo off
rem Obezlichivatel installer for Windows: double-click this file.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
