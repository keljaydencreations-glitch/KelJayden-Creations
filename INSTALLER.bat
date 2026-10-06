@echo off
title KelJayden Creations - Installation
echo Installation des dependances...
call npm.cmd install
if errorlevel 1 (
  echo.
  echo ERREUR pendant l'installation.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
echo.
echo Installation terminee.
echo Le fichier .env a ete cree si necessaire.
echo Vous pouvez maintenant lancer DEMARRER.bat
pause
