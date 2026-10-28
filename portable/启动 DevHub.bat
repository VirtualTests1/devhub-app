@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title DevHub

rem DevHub portable launcher.
rem
rem Responsibilities:
rem   1. make sure the Microsoft Edge WebView2 Runtime is present, because Tauri
rem      renders through it and Windows 10 1803+ has it but older images do not
rem   2. start DevHub from this folder
rem
rem Nothing is installed without being reported first, and git is NOT required
rem here - if the machine has no git, DevHub offers to install a portable copy
rem into runtime\git on first use.

set "HERE=%~dp0"
set "APP=%HERE%devhub-app.exe"

if not exist "%APP%" (
  echo.
  echo   [x] 找不到 devhub-app.exe
  echo       请确认本脚本与 devhub-app.exe 放在同一个文件夹内。
  echo.
  pause
  exit /b 1
)

rem --- WebView2 check ---------------------------------------------------------
rem The Evergreen Runtime registers its version under this key.
set "WV2KEY=HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
set "WV2VER="
for /f "tokens=2,*" %%A in ('reg query "%WV2KEY%" /v pv 2^>nul ^| findstr /i "pv"') do set "WV2VER=%%B"

if not "%WV2VER%"=="" goto :launch

echo.
echo   [!] 未检测到 Microsoft Edge WebView2 运行时。
echo       DevHub 的界面依赖它。Windows 11 与较新的 Windows 10 自带，
echo       这台机器上没有。
echo.

set "BOOTSTRAP=%HERE%MicrosoftEdgeWebview2Setup.exe"
if not exist "%BOOTSTRAP%" (
  echo       本目录下也没有安装程序。请联网后从下面地址安装，然后重新运行本脚本：
  echo       https://developer.microsoft.com/microsoft-edge/webview2/
  echo.
  pause
  exit /b 1
)

echo       已随包附带官方安装程序，将从微软服务器下载并安装运行时。
echo       安装程序来源：https://go.microsoft.com/fwlink/p/?LinkId=2124703
echo.
choice /c YN /n /m "      现在安装 WebView2？(Y/N) "
if errorlevel 2 (
  echo       已取消。
  pause
  exit /b 1
)

echo       正在安装…
"%BOOTSTRAP%" /silent /install
if errorlevel 1 (
  echo.
  echo   [x] 安装失败。如果不想现在安装，可以手动运行 MicrosoftEdgeWebview2Setup.exe。
  echo.
  pause
  exit /b 1
)
echo       安装完成。
echo.

:launch
cd /d "%HERE%"
start "" "%APP%"
exit /b 0
