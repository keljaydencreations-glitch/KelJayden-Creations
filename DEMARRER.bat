@echo off
title KelJayden Creations
if not exist node_modules (
  echo Les dependances ne sont pas installees.
  echo Lancez d'abord INSTALLER.bat
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
echo.
echo Demarrage de KelJayden Creations...
echo Boutique : http://localhost:3000
echo Admin    : http://localhost:3000/admin
echo.
start "" http://localhost:3000
call npm.cmd start
pause
