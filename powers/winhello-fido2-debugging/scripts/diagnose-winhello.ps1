# Run from the folder that contains fido2-assert.exe etc.
# Prints environment facts only. It does not run any assertion.
$ErrorActionPreference = "Continue"

Write-Host "== Windows ==" 
(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | Format-List | Out-String).Trim()

Write-Host "`n== Elevated? =="
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "`n== libfido2 tools in current folder =="
foreach ($f in "fido2-assert.exe","fido2-cred.exe","fido2-token.exe","fido2.dll","cbor.dll","crypto.dll","zlib1.dll") {
  "{0,-18} {1}" -f $f, (Test-Path (Join-Path (Get-Location) $f))
}

Write-Host "`n== Leftover FIDO / dialog processes =="
$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "fido2|CredentialUIBroker" }
if ($p) { $p | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize } else { "none" }

Write-Host "`nIf anything is listed above, stop it and retry before debugging further."
