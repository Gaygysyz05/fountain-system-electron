# Builds dist/fountain-daemon.exe -- a single distributable file with a
# frozen Python interpreter and every dependency bundled in, so a site
# install no longer needs Python + a hand-built `.venv` on the target
# machine (see fountain-daemon.spec's header comment). Run this before
# packaging fountain-hmi with electron-builder -- its extraResources entry
# expects this file to already exist at fountain-daemon/dist/fountain-daemon.exe.
#
# Uses THIS project's own .venv (not a system Python) so the build picks up
# the exact dependency versions development and the test suite already run
# against -- never build from a different interpreter than the one
# `requirements.txt` was validated with.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  Write-Host "No .venv found -- creating one and installing build dependencies..."
  python -m venv .venv
}

& ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
& ".venv\Scripts\python.exe" -m pip install --quiet -r requirements-build.txt

Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue

& ".venv\Scripts\python.exe" -m PyInstaller --noconfirm fountain-daemon.spec

Write-Host ""
Write-Host "Built: $PSScriptRoot\dist\fountain-daemon.exe"
