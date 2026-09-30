# D01 synthetic feasibility probe only. Not a product supervisor.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [ValidateSet('worker', 'descendant', 'timeout')][string]$Mode = 'worker',
  [ValidateSet('sample.md', 'complex-deflate-props.docx', 'complex.pdf')][string]$Fixture = 'sample.md',
  [int]$DeadlineMs = 60000
)
$ErrorActionPreference = 'Stop'
$scriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'evidence-spike.mjs')).Path
$nodePath = (Resolve-Path -LiteralPath $Node).Path
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$budget = [uint64]536870912

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class D01Job {
 [StructLayout(LayoutKind.Sequential)] public struct Basic {
  public long ProcessTime, JobTime; public uint Flags;
  public UIntPtr MinSet, MaxSet; public uint Active; public UIntPtr Affinity;
  public uint Priority, Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong A,B,C,D,E,F; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended {
  public Basic Basic; public Io Io; public UIntPtr ProcessLimit, JobLimit, ProcessPeak, JobPeak;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended data,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job,int type,out Extended data,uint size,IntPtr length);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [D01Job]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
$child = $null
$closedJob = $false
try {
  $limits = [D01Job+Extended]::new()
  $basic = [D01Job+Basic]::new()
  $basic.Flags = 0x2200 # JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $limits.Basic = $basic
  $limits.JobLimit = [UIntPtr]::new($budget)
  $size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  if (-not [D01Job]::SetInformationJobObject($job, 9, [ref]$limits, $size)) { throw 'SetInformationJobObject failed' }

  # Child waits for stdin before running any fixture/parser code. Node startup itself is not suspended.
  $wrapper = switch ($Mode) {
    'worker' { "const {pathToFileURL}=require('node:url');process.stdin.once('data',()=>{process.argv[2]='--worker';process.argv[3]=process.env.D01_FIXTURE;process.argv[4]='pdfjs4';import(pathToFileURL(process.env.D01_SCRIPT).href).then(m=>m.main()).catch(e=>{console.error(e);process.exitCode=1})});process.stdin.resume()" }
    'descendant' { "const {spawn}=require('node:child_process');process.stdin.once('data',()=>{const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(p.pid);p.unref();setInterval(()=>{},1000)});process.stdin.resume()" }
    'timeout' { "process.stdin.once('data',()=>setTimeout(()=>{},10000));process.stdin.resume()" }
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $nodePath
  $start.ArgumentList.Add('-e')
  $start.ArgumentList.Add($wrapper)
  $start.WorkingDirectory = $root
  $start.Environment['D01_SCRIPT'] = $scriptPath
  $start.Environment['D01_FIXTURE'] = $Fixture
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $child = [Diagnostics.Process]::Start($start)
  # Drain while running; waiting first can deadlock when redirected output fills its pipe.
  $stdoutTask = if ($Mode -eq 'descendant') { $child.StandardOutput.ReadLineAsync() } else { $child.StandardOutput.ReadToEndAsync() }
  $stderrTask = $child.StandardError.ReadToEndAsync()
  if (-not [D01Job]::AssignProcessToJobObject($job, $child.Handle)) { throw 'AssignProcessToJobObject failed' }
  $applied = [D01Job+Extended]::new()
  if (-not [D01Job]::QueryInformationJobObject($job, 9, [ref]$applied, $size, [IntPtr]::Zero)) { throw 'QueryInformationJobObject failed' }
  if ($applied.JobLimit.ToUInt64() -ne $budget -or ($applied.Basic.Flags -band 0x2200) -ne 0x2200) { throw 'Job limit verification failed' }
  $child.StandardInput.WriteLine('run-after-job-assignment')
  $child.StandardInput.Close()
  $descendantBeforeClose = $null
  $descendantStart = $null
  if ($Mode -eq 'descendant') {
    if (-not $stdoutTask.Wait(2000)) { throw 'Descendant PID was not emitted' }
    $reportedPid = [int]$stdoutTask.Result
    $descendantBeforeClose = Get-Process -Id $reportedPid -ErrorAction SilentlyContinue
    if ($null -ne $descendantBeforeClose) { $descendantStart = $descendantBeforeClose.StartTime }
  }
  $remaining = [Math]::Max(0, $DeadlineMs - [int]$watch.ElapsedMilliseconds)
  $exitedWithinDeadline = $child.WaitForExit($remaining)
  $elapsedAtDecision = $watch.ElapsedMilliseconds
  $timedOut = -not $exitedWithinDeadline -or $elapsedAtDecision -gt $DeadlineMs
  $peakBeforeCleanup = [D01Job+Extended]::new()
  if (-not [D01Job]::QueryInformationJobObject($job, 9, [ref]$peakBeforeCleanup, $size, [IntPtr]::Zero)) { throw 'Job peak query failed' }
  if ($timedOut -and $child.HasExited -eq $false) { [void][D01Job]::CloseHandle($job); $closedJob = $true; [void]$child.WaitForExit(5000) }
  $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
  $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
  $descendant = if ($Mode -eq 'descendant' -and $stdout -match '^\d+$') { [int]$stdout } else { $null }
  if (-not $closedJob) { [void][D01Job]::CloseHandle($job); $closedJob = $true }
  if ($null -ne $descendant) { Start-Sleep -Milliseconds 250 }
  $descendantAfterClose = if ($null -ne $descendant) { Get-Process -Id $descendant -ErrorAction SilentlyContinue } else { $null }
  $descendantGone = if ($null -ne $descendant) { $null -eq $descendantAfterClose -or $descendantAfterClose.StartTime -ne $descendantStart } else { $null }
  $result = [ordered]@{
    mode = $Mode; fixture = if ($Mode -eq 'worker') { $Fixture } else { $null }; provider = 'Windows Job Object'; metric = 'aggregate committed virtual memory'; budgetBytes = $budget
    verifiedLimitBytes = $applied.JobLimit.ToUInt64(); appliedFlags = $applied.Basic.Flags
    deadlineMs = $DeadlineMs; elapsedAtDecisionMs = $elapsedAtDecision; totalElapsedMs = $watch.ElapsedMilliseconds
    timedOut = $timedOut; exitCode = $child.ExitCode; peakJobCommittedBytes = $peakBeforeCleanup.JobPeak.ToUInt64()
    startupGatedByStdin = $true; createSuspended = $false; descendantIdentitySeenBeforeClose = ($null -ne $descendantBeforeClose); descendantGoneAfterClose = $descendantGone
    outputAccepted = (-not $timedOut -and $child.ExitCode -eq 0); workerOutputBytes = [Text.Encoding]::UTF8.GetByteCount($stdout)
    stderr = $stderr.Substring(0, [Math]::Min(300, $stderr.Length)); stdoutPreview = if ($timedOut) { $stdout.Substring(0, [Math]::Min(300, $stdout.Length)) } else { $null }
  }
  if ($Mode -eq 'worker' -and $result.outputAccepted) {
    $lines = @($stdout -split "\r?\n")
    $result.workerWarnings = @($lines | Where-Object { $_ -and -not $_.StartsWith('{') })
    $parsed = $lines[-1] | ConvertFrom-Json
    $result.selectedUnits = if ($parsed.format -eq 'docx') { $parsed.structured.units.found } elseif ($parsed.format -eq 'pdf') { $parsed.candidates[0].units.found } else { $parsed.units.found }
    $result.expectedUnits = if ($parsed.format -eq 'docx') { $parsed.structured.units.total } elseif ($parsed.format -eq 'pdf') { $parsed.candidates[0].units.total } else { $parsed.units.total }
  }
  $result | ConvertTo-Json -Depth 5
} finally {
  if ($null -ne $child -and -not $child.HasExited) { $child.Kill($true) }
  if (-not $closedJob) { [void][D01Job]::CloseHandle($job) }
  if ($null -ne $child) { $child.Dispose() }
}
