$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath 'node_modules/playwright')) {
    npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
}
$relayPort = Read-Host 'M5Stack COM port (Enter = COM7)'
if (-not $relayPort) { $relayPort = 'COM7' }
$relayUrl = Read-Host 'GAS /exec URL (USB test only: type TEST)'
if ($relayUrl -eq 'TEST') { $relayUrl = '--test' }
node relay.js $relayPort $relayUrl
Read-Host 'Press Enter to close'
