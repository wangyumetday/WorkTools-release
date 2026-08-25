$ErrorActionPreference = 'SilentlyContinue'

function Get-DirSize($path) {
  if (-not (Test-Path $path)) { return 0 }
  $sum = 0
  Get-ChildItem $path -Recurse -File | ForEach-Object { $sum += $_.Length }
  return $sum
}

Write-Host "===== out 目录 ====="
$outSize = Get-DirSize "out"
Write-Host ("out 总计: {0} MB" -f [math]::Round($outSize/1MB, 2))

Get-ChildItem "out" -Directory | ForEach-Object {
  $s = Get-DirSize $_.FullName
  Write-Host ("  {0}: {1} MB" -f $_.Name, [math]::Round($s/1MB, 2))
}

Write-Host ""
Write-Host "===== node_modules Top 15 ====="
Get-ChildItem "node_modules" -Directory | ForEach-Object {
  $s = Get-DirSize $_.FullName
  [PSCustomObject]@{ Name = $_.Name; MB = [math]::Round($s/1MB, 2) }
} | Sort-Object MB -Descending | Select-Object -First 15 | Format-Table -AutoSize

Write-Host ""
Write-Host "===== 关键依赖体积 ====="
$keys = @('vue', 'vue-router', 'pinia', 'pinia-plugin-persistedstate', 'naive-ui', '@vicons', 'xlsx', 'decimal.js', 'electron-updater')
foreach ($k in $keys) {
  $matches = Get-ChildItem "node_modules" -Directory -Filter "$k*" -Recurse -Depth 1
  foreach ($m in $matches) {
    $s = Get-DirSize $m.FullName
    Write-Host ("{0}: {1} MB" -f $m.FullName.Replace($PWD.Path + '\node_modules\', ''), [math]::Round($s/1MB, 2))
  }
}
