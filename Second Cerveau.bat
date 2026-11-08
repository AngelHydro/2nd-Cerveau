@echo off
rem Lance le Second Cerveau : compile l'interface, démarre le serveur puis ouvre le navigateur.
rem Ferme cette fenêtre pour arrêter le serveur.
chcp 65001 >nul
title Second Cerveau
cd /d "%~dp0"

if not exist node_modules (
  echo Premiere installation des dependances...
  call npm install --no-audit --no-fund || goto :error
)

call npx vite build --logLevel error || goto :error

start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:4321"
node --import tsx server\main.ts
if errorlevel 1 goto :error
goto :eof

:error
echo.
echo Le Second Cerveau n'a pas pu demarrer (voir le message ci-dessus).
pause
