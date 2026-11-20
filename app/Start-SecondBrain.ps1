param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$url='http://127.0.0.1:8877'
$running=$false
try{$r=Invoke-RestMethod -Uri "$url/api/stats" -TimeoutSec 2;$running=$r.app -eq 'secondbrain-local-v1'}catch{}
if(-not $running){
 $task=Get-ScheduledTask -TaskName 'SecondBrain Local Service' -ErrorAction SilentlyContinue
 if(-not $task){throw 'Фоновая служба SecondBrain не установлена. Запустите Install-SecondBrain-Startup.ps1 из папки приложения.'}
 Start-ScheduledTask -TaskName $task.TaskName
 for($attempt=0;$attempt -lt 60;$attempt++){
  Start-Sleep -Milliseconds 250
  try{$r=Invoke-RestMethod -Uri "$url/api/stats" -TimeoutSec 2;if($r.app -eq 'secondbrain-local-v1'){$running=$true;break}}catch{}
 }
}
if(-not $running){throw 'SecondBrain не запустился. Подробности — supervisor.log в папке приложения.'}
if(-not $NoBrowser){Start-Process $url}
Write-Output $url
