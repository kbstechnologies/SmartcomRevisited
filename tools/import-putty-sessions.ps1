<#
.SYNOPSIS
    Converts saved PuTTY sessions into a Smartcom Revisited connections file.

.DESCRIPTION
    Reads PuTTY's saved sessions - from the registry of the user running the
    script, or from a .reg file exported elsewhere - and writes a
    `.connections.json` bundle that Smartcom Revisited can import.

    Nothing is written to the registry and nothing is sent anywhere: this reads
    PuTTY's settings and writes one file. The app's importer is additive, so
    importing the result never overwrites connections that already exist.

    PuTTY stores no passwords, so none are carried across.

.PARAMETER OutFile
    Where to write the bundle. Defaults to putty-sessions.connections.json on
    the Desktop.

.PARAMETER RegFile
    Read sessions from a exported .reg file instead of this user's registry.
    Useful for migrating someone else's machine:
        reg export "HKCU\Software\SimonTatham\PuTTY\Sessions" putty.reg

.PARAMETER DefaultUser
    Username for sessions where PuTTY has none saved - very common, because
    PuTTY simply asks at connect time, while Smartcom Revisited stores it on the
    connection. Defaults to the current Windows username.

.PARAMETER GroupName
    Folder the imported connections are placed in. Defaults to "PuTTY import".

.EXAMPLE
    .\import-putty-sessions.ps1
    .\import-putty-sessions.ps1 -DefaultUser admin -OutFile C:\temp\putty.json
    .\import-putty-sessions.ps1 -RegFile .\colleague-putty.reg
#>
[CmdletBinding()]
param(
    [string] $OutFile,
    [string] $RegFile,
    [string] $DefaultUser = $env:USERNAME,
    [string] $GroupName = 'PuTTY import',
    [string] $RegistryPath = 'HKCU:\Software\SimonTatham\PuTTY\Sessions'
)

$ErrorActionPreference = 'Stop'

# Matches src/shared/types.ts - the app validates this on import.
$FORMAT = 'smartcom-revisited/connections'

# PuTTY's numeric encodings.
$PARITY = @{ 0 = 'none'; 1 = 'odd'; 2 = 'even'; 3 = 'mark'; 4 = 'space' }
$FLOW = @{ 0 = 'none'; 1 = 'xonxoff'; 2 = 'rtscts'; 3 = 'none' }   # 3 = DSR/DTR, unsupported

function New-Uuid { [guid]::NewGuid().ToString() }

<#
    Reads sessions from an exported .reg file.

    Values look like:
        [HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\my%20box]
        "HostName"="10.0.0.1"
        "PortNumber"=dword:00000016
#>
function Read-SessionsFromRegFile {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "No such .reg file: $Path" }

    # .reg exports are UTF-16 with a BOM; Get-Content handles that when told.
    $lines = Get-Content -LiteralPath $Path -Encoding Unicode
    if ($lines.Count -le 1) { $lines = Get-Content -LiteralPath $Path }

    $sessions = @()
    $current = $null

    foreach ($line in $lines) {
        $text = $line.Trim()

        if ($text -match '^\[.*\\Sessions\\(?<name>[^\]]+)\]$') {
            if ($current) { $sessions += $current }
            $current = [pscustomobject]@{ Name = $Matches['name']; Values = @{} }
            continue
        }
        if ($text -match '^\[') { if ($current) { $sessions += $current }; $current = $null; continue }
        if (-not $current) { continue }

        if ($text -match '^"(?<key>[^"]+)"="(?<value>.*)"$') {
            $value = $Matches['value'] -replace '\\\\', '\' -replace '\\"', '"'
            $current.Values[$Matches['key']] = $value
        }
        elseif ($text -match '^"(?<key>[^"]+)"=dword:(?<value>[0-9a-fA-F]+)$') {
            $current.Values[$Matches['key']] = [Convert]::ToInt32($Matches['value'], 16)
        }
    }
    if ($current) { $sessions += $current }

    return $sessions
}

function Read-SessionsFromRegistry {
    param([string] $Path)

    if (-not (Test-Path $Path)) {
        throw "No PuTTY sessions found at $Path. Is PuTTY installed for this user?"
    }

    Get-ChildItem $Path | ForEach-Object {
        $values = @{}
        $item = Get-ItemProperty $_.PSPath
        foreach ($property in $item.PSObject.Properties) {
            if ($property.Name -notlike 'PS*') { $values[$property.Name] = $property.Value }
        }
        [pscustomobject]@{ Name = $_.PSChildName; Values = $values }
    }
}

# --- read ---------------------------------------------------------------------

$raw = if ($RegFile) { Read-SessionsFromRegFile -Path $RegFile } else { Read-SessionsFromRegistry -Path $RegistryPath }

$groupId = New-Uuid
$profiles = @()
$skipped = @()
$noUser = @()
$ppkKeys = @()
$usedNames = @{}

foreach ($session in $raw) {
    # PuTTY escapes session names for the registry: "my box" -> "my%20box".
    $name = [Uri]::UnescapeDataString($session.Name)
    if ($name -eq 'Default Settings') { continue }

    $values = $session.Values
    $protocol = [string]$values['Protocol']
    if (-not $protocol) { $protocol = 'ssh' }

    # Two connections cannot share a name in Smartcom Revisited.
    $unique = $name
    $suffix = 2
    while ($usedNames.ContainsKey($unique)) { $unique = "$name ($suffix)"; $suffix++ }
    $usedNames[$unique] = $true

    switch ($protocol.ToLower()) {
        'ssh' {
            $host_ = [string]$values['HostName']
            if (-not $host_) { $skipped += "$name - no hostname saved"; continue }

            $user = [string]$values['UserName']
            if (-not $user) { $user = $DefaultUser; $noUser += $unique }

            $keyFile = [string]$values['PublicKeyFile']
            $auth = if ($keyFile) { 'key' } else { 'password' }
            if ($keyFile) { $ppkKeys += "$unique -> $keyFile" }

            $port = if ($values['PortNumber']) { [int]$values['PortNumber'] } else { 22 }

            $profile = [ordered]@{
                id          = New-Uuid
                name        = $unique
                transport   = 'ssh'
                groupId     = $groupId
                host        = $host_
                port        = $port
                username    = $user
                authMethod  = $auth
                baudRate    = 115200
                dataBits    = 8
                stopBits    = 1
                parity      = 'none'
                flowControl = 'none'
            }
            if ($keyFile) { $profile['keyPath'] = $keyFile }
            $profiles += $profile
        }

        'serial' {
            # Every PuTTY session carries serial defaults, so the protocol is
            # what decides this - not the presence of a SerialLine value.
            $line = [string]$values['SerialLine']
            if (-not $line) { $skipped += "$name - serial session with no port"; continue }

            $dataBits = if ($values['SerialDataBits']) { [int]$values['SerialDataBits'] } else { 8 }
            if ($dataBits -lt 5 -or $dataBits -gt 8) { $dataBits = 8 }

            # PuTTY counts stop bits in halves: 2 = one stop bit, 4 = two.
            $halfBits = if ($values['SerialStopHalfbits']) { [int]$values['SerialStopHalfbits'] } else { 2 }
            $stopBits = if ($halfBits -ge 4) { 2 } else { 1 }

            $parityCode = if ($values['SerialParity']) { [int]$values['SerialParity'] } else { 0 }
            $flowCode = if ($values['SerialFlowControl']) { [int]$values['SerialFlowControl'] } else { 0 }
            if ($flowCode -eq 3) { $skipped += "$unique - DSR/DTR flow control is not supported, set to none" }

            $profiles += [ordered]@{
                id          = New-Uuid
                name        = $unique
                transport   = 'serial'
                groupId     = $groupId
                host        = ''
                port        = 22
                username    = ''
                authMethod  = 'password'
                serialPath  = $line
                baudRate    = if ($values['SerialSpeed']) { [int]$values['SerialSpeed'] } else { 115200 }
                dataBits    = $dataBits
                stopBits    = $stopBits
                parity      = $(if ($PARITY.ContainsKey($parityCode)) { $PARITY[$parityCode] } else { 'none' })
                flowControl = $(if ($FLOW.ContainsKey($flowCode)) { $FLOW[$flowCode] } else { 'none' })
            }
        }

        default {
            $skipped += "$name - $protocol is not supported"
        }
    }
}

if ($profiles.Count -eq 0) { throw 'No SSH or serial sessions could be converted.' }

# --- write --------------------------------------------------------------------

if (-not $OutFile) {
    $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'putty-sessions.connections.json'
}

$bundle = [ordered]@{
    format     = $FORMAT
    version    = 1
    exportedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exportedBy = 'import-putty-sessions.ps1'
    groups     = @(
        [ordered]@{ id = $groupId; name = $GroupName; description = 'Imported from PuTTY'; sortOrder = 0 }
    )
    profiles   = $profiles
}

# -Depth matters: without it ConvertTo-Json flattens the nested arrays to type
# names and the file silently becomes unimportable.
$json = $bundle | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($OutFile, $json, [Text.UTF8Encoding]::new($false))

# --- report -------------------------------------------------------------------

Write-Host ''
Write-Host "Converted $($profiles.Count) session(s) -> $OutFile" -ForegroundColor Green
Write-Host ''
Write-Host 'In Smartcom Revisited: New -> Import, then pick that file.'
Write-Host 'Importing adds these alongside what you already have; nothing is replaced.'

if ($noUser.Count -gt 0) {
    Write-Host ''
    Write-Host "$($noUser.Count) session(s) had no username saved in PuTTY, so '$DefaultUser' was used:" -ForegroundColor Yellow
    $noUser | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
    if ($noUser.Count -gt 10) { Write-Host "  ...and $($noUser.Count - 10) more" }
    Write-Host '  Re-run with -DefaultUser <name> if that is wrong.'
}

if ($ppkKeys.Count -gt 0) {
    Write-Host ''
    Write-Host "$($ppkKeys.Count) session(s) use a PuTTY key file:" -ForegroundColor Yellow
    $ppkKeys | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
    Write-Host '  .ppk is PuTTY''s own format. Convert each one with PuTTYgen'
    Write-Host '  (Conversions -> Export OpenSSH key) and point the connection at that file.'
}

if ($skipped.Count -gt 0) {
    Write-Host ''
    Write-Host "$($skipped.Count) session(s) skipped or adjusted:" -ForegroundColor Yellow
    $skipped | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }
    if ($skipped.Count -gt 15) { Write-Host "  ...and $($skipped.Count - 15) more" }
}

Write-Host ''
