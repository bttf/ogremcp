# Builds the Windows installer (docs/architecture.md §7 Installer,
# docs/releases.md) from the Windows binary GoReleaser built: Inno Setup's
# compiler runs windows/ogremcp-bridge.iss. The installer is unsigned (§7, D6).
#
#   pwsh -File scripts/windows-installer.ps1 -Exe EXE -OutDir DIR
#
# EXE has the name a release gives the binary,
# ogremcp-bridge_<version>_windows_amd64.exe. The script writes
# DIR/ogremcp-bridge_<version>_windows_amd64_setup.exe. It runs on Windows,
# with Inno Setup 6.3 or later, which GitHub's Windows runners have.
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $OutDir
)
$ErrorActionPreference = 'Stop'

$name = Split-Path -Leaf $Exe
if ($name -notmatch '^ogremcp-bridge_([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)_windows_amd64\.exe$') {
  throw "$name is not named ogremcp-bridge_<version>_windows_amd64.exe."
}
$version = $Matches[1]
$exePath = (Resolve-Path -LiteralPath $Exe).Path

# ISCC.exe on PATH, or else in Inno Setup 6's default folder.
$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
}
if (-not (Test-Path -LiteralPath $iscc)) {
  throw "Inno Setup's compiler, ISCC.exe, is not installed."
}
Write-Host "Compiler: $iscc"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outPath = (Resolve-Path -LiteralPath $OutDir).Path
$script = Join-Path $PSScriptRoot '..\windows\ogremcp-bridge.iss'

& $iscc "/DBridgeVersion=$version" "/DBridgeExe=$exePath" "/O$outPath" $script
if ($LASTEXITCODE -ne 0) {
  throw "ISCC.exe failed with exit code $LASTEXITCODE."
}

$setup = Join-Path $outPath "ogremcp-bridge_${version}_windows_amd64_setup.exe"
if (-not (Test-Path -LiteralPath $setup)) {
  throw "ISCC.exe did not write $setup."
}
Write-Host "Built $setup"
