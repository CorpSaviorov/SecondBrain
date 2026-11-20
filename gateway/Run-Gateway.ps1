# Keeps the SecondBrain gateway running (restarts it after exit). Started at logon by Install-Gateway-Startup.ps1.
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$node=(Get-Command node.exe -ErrorAction Stop).Source
$mutex=[Threading.Mutex]::new($false,'Local\SecondBrainGateway-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$acquired=$false
function Write-Log([string]$m){Add-Content -LiteralPath (Join-Path $root 'supervisor.log') -Value ((Get-Date).ToString('o')+' '+$m)}
try{
 try{$acquired=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true}
 if(-not $acquired){exit 0}
 Write-Log 'Supervisor started'
 $delay=2
 for(;;){
  $started=Get-Date
  $child=Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $root 'server.mjs')+'"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'server.stdout.log') -RedirectStandardError (Join-Path $root 'server.stderr.log') -PassThru
  Write-Log ('Gateway started; pid='+$child.Id)
  while(-not $child.HasExited){Start-Sleep -Seconds 3;$child.Refresh()}
  Write-Log ('Gateway exited; exit='+$child.ExitCode)
  if(((Get-Date)-$started).TotalSeconds -gt 60){$delay=2}else{$delay=[Math]::Min(60,$delay*2)}
  Start-Sleep -Seconds $delay
 }
}catch{Write-Log ('Supervisor error: '+$_.Exception.Message);exit 1}finally{if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()}
