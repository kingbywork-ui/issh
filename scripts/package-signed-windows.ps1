[CmdletBinding()]
param(
    [string]$CertificatePath = $env:ISSH_AUTHENTICODE_PFX,
    [string]$CertificateThumbprint = $env:ISSH_AUTHENTICODE_THUMBPRINT,
    [string]$TimestampUrl = $(if ($env:ISSH_AUTHENTICODE_TIMESTAMP_URL) { $env:ISSH_AUTHENTICODE_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }),
    [string]$SigntoolPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SigntoolPath) { $SigntoolPath = Join-Path $repoRoot 'build/windows/signtool.exe' }
if (-not (Test-Path -LiteralPath $SigntoolPath -PathType Leaf)) { throw "signtool.exe not found: $SigntoolPath" }
if ($CertificatePath -and $CertificateThumbprint) { throw 'Specify either ISSH_AUTHENTICODE_PFX or ISSH_AUTHENTICODE_THUMBPRINT, not both.' }
if (-not $CertificatePath -and -not $CertificateThumbprint) { throw 'Formal Authenticode signing requires ISSH_AUTHENTICODE_PFX or ISSH_AUTHENTICODE_THUMBPRINT.' }

function Invoke-Native([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

$stagedRuntime = Join-Path $repoRoot 'issh-tauri/src-tauri/bin/isshd.exe'
Invoke-Native 'cargo' @('build', '--release', '-p', 'isshd') (Join-Path $repoRoot 'issh-runtime')
Invoke-Native 'node' @('scripts/stage-runtime.mjs') (Join-Path $repoRoot 'issh-tauri')

$common = @('sign', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', '/d', 'issh Runtime')
if ($CertificatePath) {
    $pfx = (Resolve-Path -LiteralPath $CertificatePath -ErrorAction Stop).Path
    $password = if ($null -eq $env:ISSH_AUTHENTICODE_PFX_PASSWORD) { '' } else { $env:ISSH_AUTHENTICODE_PFX_PASSWORD }
    $signArgs = $common + @('/f', $pfx, '/p', $password)
} else {
    $signArgs = $common + @('/sha1', ($CertificateThumbprint -replace '\s', ''))
}
& $SigntoolPath @signArgs ((Resolve-Path -LiteralPath $stagedRuntime).Path)
if ($LASTEXITCODE -ne 0) { throw "isshd.exe signing failed ($LASTEXITCODE)" }

Invoke-Native 'npm.cmd' @('run', 'tauri', '--', 'build') (Join-Path $repoRoot 'issh-tauri')
& (Join-Path $repoRoot 'scripts/sign-windows.ps1') `
    -CertificatePath $CertificatePath `
    -CertificateThumbprint $CertificateThumbprint `
    -TimestampUrl $TimestampUrl `
    -SigntoolPath $SigntoolPath `
    -RuntimePath $stagedRuntime
if ($LASTEXITCODE -ne 0) { throw "final Authenticode signing failed ($LASTEXITCODE)" }
