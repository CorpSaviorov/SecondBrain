$ErrorActionPreference='Stop'
$appRoot=$PSScriptRoot
$url='http://127.0.0.1:8877'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$mutexName='Local\SecondBrainLocal-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+'-8877'
$mutex=[Threading.Mutex]::new($false,$mutexName)
$acquired=$false
function Write-LaunchLog([string]$message){Add-Content -LiteralPath (Join-Path $appRoot 'supervisor.log') -Value ((Get-Date).ToString('o')+' '+$message)}
function Test-Brain {try{$r=Invoke-RestMethod -Uri "$url/api/stats" -TimeoutSec 3;return $r.app -eq 'secondbrain-local-v1'}catch{return $false}}
try{
 try{$acquired=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true}
 if(-not $acquired){exit 0}
 Write-LaunchLog 'Supervisor started'
 $delay=2
 for(;;){
  if(Test-Brain){Start-Sleep -Seconds 5;continue}
  $port=Get-NetTCPConnection -LocalPort 8877 -State Listen -ErrorAction SilentlyContinue
  if($port){Write-LaunchLog 'Port occupied; no foreign process was stopped';Start-Sleep -Seconds 15;continue}
  foreach($log in @('server.stdout.log','server.stderr.log')){$file=Join-Path $appRoot $log;if((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length){Copy-Item -LiteralPath $file -Destination ($file+'.previous') -Force}}
  $started=Get-Date
  $child=Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $appRoot 'server.mjs')+'"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot 'server.stdout.log') -RedirectStandardError (Join-Path $appRoot 'server.stderr.log') -PassThru
  Write-LaunchLog ('Server started; pid='+$child.Id)
  while(-not $child.HasExited){Start-Sleep -Seconds 3;$child.Refresh()}
  Write-LaunchLog ('Server exited; exit='+$child.ExitCode)
  if(((Get-Date)-$started).TotalSeconds -gt 60){$delay=2}else{$delay=[Math]::Min(60,$delay*2)}
  Start-Sleep -Seconds $delay
 }
}catch{Write-LaunchLog ('Supervisor error: '+$_.Exception.Message);exit 1}finally{if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()}
