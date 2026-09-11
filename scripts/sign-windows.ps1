[CmdletBinding()]
param(
    [string]$InstallerPath = '',
    [string]$AppPath = '',
    [string]$RuntimePath = '',
    [string]$CertificatePath = $env:ISSH_AUTHENTICODE_PFX,
    [string]$CertificateThumbprint = $env:ISSH_AUTHENTICODE_THUMBPRINT,
    [string]$TimestampUrl = $(if ($env:ISSH_AUTHENTICODE_TIMESTAMP_URL) { $env:ISSH_AUTHENTICODE_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }),
    [string]$SigntoolPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SigntoolPath) { $SigntoolPath = Join-Path $repoRoot 'build/windows/signtool.exe' }
if (-not (Test-Path -LiteralPath $SigntoolPath -PathType Leaf)) {
    throw "signtool.exe not found: $SigntoolPath"
}

if (-not $InstallerPath) {
    $InstallerPath = Join-Path $repoRoot 'issh-tauri/src-tauri/target/release/bundle/nsis/issh_0.0.4_x64-setup.exe'
}
if (-not $AppPath) { $AppPath = Join-Path $repoRoot 'issh-tauri/src-tauri/target/release/issh-tauri.exe' }
if (-not $RuntimePath) { $RuntimePath = Join-Path $repoRoot 'issh-runtime/target/release/isshd.exe' }

$targets = @($RuntimePath, $AppPath, $InstallerPath) | ForEach-Object {
    (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path
}

if ($CertificatePath -and $CertificateThumbprint) {
    throw 'Specify either ISSH_AUTHENTICODE_PFX or ISSH_AUTHENTICODE_THUMBPRINT, not both.'
}
if (-not $CertificatePath -and -not $CertificateThumbprint) {
    throw 'Formal Authenticode signing requires ISSH_AUTHENTICODE_PFX or ISSH_AUTHENTICODE_THUMBPRINT.'
}

$common = @('sign', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', '/d', 'issh Terminal')
if ($CertificatePath) {
    $pfx = (Resolve-Path -LiteralPath $CertificatePath -ErrorAction Stop).Path
    $password = $env:ISSH_AUTHENTICODE_PFX_PASSWORD
    if ($null -eq $password) { $password = '' }
    $signArgs = $common + @('/f', $pfx, '/p', $password)
} else {
    $signArgs = $common + @('/sha1', ($CertificateThumbprint -replace '\s', ''))
}

foreach ($target in $targets) {
    & $SigntoolPath @signArgs $target
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed ($LASTEXITCODE): $target" }
}

foreach ($target in $targets) {
    & $SigntoolPath verify /pa /all /tw $target
    if ($LASTEXITCODE -ne 0) { throw "signtool verify failed ($LASTEXITCODE): $target" }
}

Write-Host "Authenticode signatures verified for $($targets.Count) files. Timestamp: $TimestampUrl"
