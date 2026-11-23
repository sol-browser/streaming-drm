# Builds the Sol Streaming DRM component from app/ and the castLabs ECS release
# pinned in ecs.lock.json:
#   out/Sol-Streaming-DRM-<id>-win-x64.zip, its .sha256, release.json and notes.md
# <id> is "<ECS version>-<revision>", for example 45.2.1-7.
# -Sign requests a streaming VMP signature from castLabs EVS (the account must
# already be authenticated: castlabs_evs.account -n reauth) and verifies it.
# Without -Sign the package is built for inspection only and is not zipped.
param([Parameter(Mandatory)][ValidateRange(1, 9999)][int]$Revision,
      [switch]$Sign)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 turns a native tool's stderr (npm warnings, EVS progress)
# into terminating errors under 'Stop'. Native tools run through this instead,
# and every call checks $LASTEXITCODE.
function Invoke-Native([scriptblock]$Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
}
$root = Split-Path $PSScriptRoot -Parent
$lock = Get-Content -LiteralPath (Join-Path $root 'ecs.lock.json') -Raw | ConvertFrom-Json
if ($lock.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid ECS version in ecs.lock.json' }
$id = "$($lock.version)-$Revision"
$work = Join-Path $root 'work'
$out = Join-Path $root 'out'
foreach ($folder in $work, $out) { if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force } }
New-Item -ItemType Directory -Force -Path $work, $out | Out-Null

# castLabs ECS, checked against the pinned SHA-256.
$zip = Join-Path $work "electron-v$($lock.version)-win32-x64.zip"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri $lock.url -OutFile $zip
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $lock.sha256) { throw 'ECS archive does not match ecs.lock.json' }

# Packaging tools at the pinned versions.
$tools = Join-Path $work 'tools'
Invoke-Native { npm install --no-save --no-package-lock --ignore-scripts --prefix $tools `
    "@electron/packager@$($lock.tools.'@electron/packager')" "@electron/fuses@$($lock.tools.'@electron/fuses')" } | Out-Host
if ($LASTEXITCODE) { throw 'Unable to install the Electron packaging tools' }
$packager = Join-Path $tools 'node_modules/@electron/packager/bin/electron-packager.mjs'
$fuses = Join-Path $tools 'node_modules/@electron/fuses/dist/bin.js'

# Windows shows FileDescription as the process name (Task Manager, volume
# mixer, media controls) and the exe icon beside it. Branding changes the exe,
# so it happens before the VMP signature.
$packArgs = @('--platform=win32', '--arch=x64', "--electron-version=$($lock.version)", "--electron-zip-dir=$work",
    '--asar', "--out=$work", "--tmpdir=$work", '--no-prune',
    "--icon=$(Join-Path $root 'resources/sol.ico')",
    '--win32metadata.FileDescription=Sol', '--win32metadata.ProductName=Sol', '--win32metadata.CompanyName=Sol',
    '--win32metadata.InternalName=SolProtectedMedia', '--win32metadata.OriginalFilename=SolProtectedMedia.exe',
    '--app-copyright=Sol browser')
Invoke-Native { node $packager (Join-Path $root 'app') SolProtectedMedia @packArgs } | Out-Host
if ($LASTEXITCODE) { throw 'Unable to package the component' }
$package = Join-Path $work 'SolProtectedMedia-win32-x64'
$exe = Join-Path $package 'SolProtectedMedia.exe'
# The fuse configuration castLabs supports for VMP-signed apps.
Invoke-Native { node $fuses write --app $exe RunAsNode=off EnableCookieEncryption=on EnableNodeOptionsEnvironmentVariable=off `
    EnableNodeCliInspectArguments=off EnableEmbeddedAsarIntegrityValidation=on OnlyLoadAppFromAsar=on `
    LoadBrowserProcessSpecificV8Snapshot=off GrantFileProtocolExtraPrivileges=on } | Out-Host
if ($LASTEXITCODE) { throw 'Unable to write the fuses' }
if ((Get-Item -LiteralPath $exe).VersionInfo.FileDescription -ne 'Sol') { throw 'The component is not branded as Sol' }
foreach ($required in 'resources/app.asar', 'LICENSE', 'LICENSES.chromium.html') {
    if (!(Test-Path -LiteralPath (Join-Path $package $required))) { throw "Package is missing $required" }
}
if (!$Sign) { Write-Output $package; return }

# Nothing may change the exe after this point.
Invoke-Native { python -m castlabs_evs.vmp -n sign-pkg $package } | Out-Host
if ($LASTEXITCODE) { throw 'VMP signing failed' }
$receipt = Invoke-Native { python -m castlabs_evs.vmp -n verify-pkg $package }
if ($LASTEXITCODE -or ($receipt -join ' ') -notmatch 'Signature is valid:\s+streaming') { throw "No valid streaming VMP signature: $receipt" }
if (!(Test-Path -LiteralPath (Join-Path $package 'SolProtectedMedia.exe.sig'))) { throw 'Package is missing SolProtectedMedia.exe.sig' }

# Windows' own bsdtar writes the zip; Sol unpacks it with the same tool.
$name = "Sol-Streaming-DRM-$id-win-x64.zip"
$archive = Join-Path $out $name
Invoke-Native { & "$env:SystemRoot\System32\tar.exe" -a -c -f $archive -C $package * } | Out-Host
if ($LASTEXITCODE) { throw 'Unable to create the archive' }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $name" | Set-Content -LiteralPath (Join-Path $out "$name.sha256") -Encoding ascii
$installed = (Get-ChildItem -LiteralPath $package -Recurse -File | Measure-Object Length -Sum).Sum
$commit = ((Invoke-Native { git -C $root rev-parse HEAD }) -join '').Trim()
$signature = (($receipt | Select-String 'Signature is valid' | Select-Object -First 1).Line -replace '^\W+', '').Trim()
# Sol's pin script reads this file (id, file, sha256, size, installedSize).
[ordered]@{ id = $id; file = $name; sha256 = $hash; size = (Get-Item -LiteralPath $archive).Length; installedSize = $installed
    ecs = $lock.release; chromium = $lock.chromium; commit = $commit; signature = $signature } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'release.json') -Encoding utf8
@"
Sol Streaming DRM component $id.

- castLabs ECS $($lock.release) (Chromium $($lock.chromium)), VMP: $signature
- Built from $commit by the release workflow
- SHA-256: ``$hash``

Sol downloads this archive only when a person turns Streaming DRM on, and
accepts it only with the size and SHA-256 pinned in that Sol build.
"@ | Set-Content -LiteralPath (Join-Path $out 'notes.md') -Encoding utf8
Write-Output $archive
