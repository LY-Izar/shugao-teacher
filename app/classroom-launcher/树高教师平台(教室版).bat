@echo off
title Shugao Teacher Platform - Classroom
setlocal
set "URL=https://shugao-teacher.pages.dev/classroom"
set "FLAGS=--app=%URL% --start-fullscreen --autoplay-policy=no-user-gesture-required --disable-features=Translate"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" %FLAGS%
  exit /b
)

rem Edge not found - fall back to Chrome
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" %FLAGS%
  exit /b
)

echo Edge / Chrome not found. Please install Microsoft Edge.
pause
