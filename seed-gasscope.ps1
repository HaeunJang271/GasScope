param([string]$KeyName = "mykey")
$ErrorActionPreference = "Stop"
$Rpc = "https://rpc.latest.testnets.gno.land:443"
$Registry = "gno.land/r/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/gasscope_reg"
$Realms = @(
  
  
  "gno.land/r/sys/users",
  "gno.land/r/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/realmflow2",
  "gno.land/r/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/gasscope_reg",
  "gno.land/r/g15crxnxd79syggtha6ymfhy8m8a4ytqel58cwkg/tavern2048/v0",
  "gno.land/r/g1ty0rp975ndkcse760v0zt659f4phs4z8lueud7/oathledger",
  "gno.land/r/g1kkcw4krnhxadt08gjxs5ud2jhv87rtlzt29thy/milestone_escrow"
)
function Query-OnyxFile([string]$PathStr) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PathStr))
  $body = @{ jsonrpc = "2.0"; id = 1; method = "abci_query"; params = @{ path = "vm/qfile"; data = $b64 } } | ConvertTo-Json -Compress
  $res = Invoke-RestMethod -Uri $Rpc -Method Post -ContentType "application/json" -Body $body
  $rb = $res.result.response.ResponseBase
  if ($rb.Error -ne $null) { throw "RPC error for $PathStr : $($rb.Log)" }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rb.Data))
}
$tmpRoot = Join-Path $env:TEMP ("gasscope_seed_" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpRoot | Out-Null
try {
  foreach ($realm in $Realms) {
    Write-Host "`n=== Analyzing $realm ===" -ForegroundColor Cyan
    $listing = Query-OnyxFile $realm
    $files = $listing -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[\w.-]+\.gno$' -and $_ -notmatch '_(test|filetest)\.gno$' }
    if (-not $files) { continue }
    $rDir = Join-Path $tmpRoot ($realm -replace '[/:]', '_')
    New-Item -ItemType Directory -Path $rDir | Out-Null
    foreach ($f in $files) {
      [IO.File]::WriteAllText((Join-Path $rDir $f), (Query-OnyxFile "$realm/$f"), [Text.Encoding]::UTF8)
    }
    go run ./cmd/gasscope analyze $rDir
    if ($LASTEXITCODE -ne 0) { continue }
    $report = Get-Content "gasscope-report.json" -Raw | ConvertFrom-Json
    $allHotspots = @()
    foreach ($fn in $report.functions) { if ($fn.hotspots) { $allHotspots += $fn.hotspots } }
    $topRule = if ($allHotspots.Count -gt 0) { ($allHotspots | Sort-Object -Property estimatedGas -Descending | Select-Object -First 1).rule } else { "" }
    $compactJson = ($report | ConvertTo-Json -Depth 20 -Compress)
    if ([Text.Encoding]::UTF8.GetByteCount($compactJson) -gt 32000) { Write-Warning "Skipping $realm (>32KB)"; continue }
    Write-Host "Submitting $realm..." -ForegroundColor Green
    gnokey maketx call -pkgpath $Registry -func SubmitProfile -args $realm -args "$($report.totalGas)" -args "$($allHotspots.Count)" -args $topRule -args $compactJson -gas-fee 15000ugnot -gas-wanted 15000000 -chainid onyx-1 -remote $Rpc -broadcast $KeyName
  }
} finally {
  Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
}
