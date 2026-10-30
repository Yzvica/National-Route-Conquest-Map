# 指定のポートで待ち受けているプロセスを止める。タスクを止めても node が残ってポートを
# ふさぎ、新しいサーバーが起動できなくなるのを防ぐ。
param([int]$Port = 8080)
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
