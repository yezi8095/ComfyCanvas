[CmdletBinding()]
param(
  [string]$OutputDirectory = "",
  [string]$FfmpegPath = ""
)

$ErrorActionPreference = "Stop"
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $PSScriptRoot "..\tests\fixtures\generated"
}

function Resolve-LocalFfmpeg {
  if ($FfmpegPath) {
    if (-not (Test-Path -LiteralPath $FfmpegPath -PathType Leaf)) {
      throw "The specified ffmpeg executable does not exist: $FfmpegPath"
    }
    return (Resolve-Path -LiteralPath $FfmpegPath).Path
  }

  $pathCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($pathCommand) {
    return $pathCommand.Source
  }

  $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  $candidates = @(
    (Join-Path $repositoryRoot "release\ffmpeg.exe"),
    (Join-Path $repositoryRoot "src-tauri\target\debug\ffmpeg.exe"),
    (Join-Path $repositoryRoot "src-tauri\target\release\ffmpeg.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "ffmpeg was not found. Add it to PATH or pass -FfmpegPath with a local ffmpeg.exe."
}

function Invoke-CheckedFfmpeg {
  param([string[]]$Arguments)
  & $script:Ffmpeg @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed with exit code $LASTEXITCODE."
  }
}

function Assert-FileRange {
  param(
    [string]$Path,
    [long]$MinimumBytes = 1,
    [long]$MaximumBytes = [long]::MaxValue
  )
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -lt $MinimumBytes -or $file.Length -gt $MaximumBytes) {
    throw "Fixture size is outside the expected range: $($file.FullName); actual=$($file.Length), expected=$MinimumBytes..$MaximumBytes bytes."
  }
  return $file
}

$script:Ffmpeg = Resolve-LocalFfmpeg
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$smallImage = Join-Path $resolvedOutput "small-image-under-4mb.png"
$largeImage = Join-Path $resolvedOutput "large-image-over-4mb.bmp"
$sampleVideo = Join-Path $resolvedOutput "sample-video-4s.mp4"
$sampleAudio = Join-Path $resolvedOutput "sample-audio-3s.wav"

Invoke-CheckedFfmpeg @(
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1",
  "-frames:v", "1", "-threads", "1", $smallImage
)
Invoke-CheckedFfmpeg @(
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1",
  "-frames:v", "1", "-c:v", "bmp", $largeImage
)
Invoke-CheckedFfmpeg @(
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
  "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=44100",
  "-t", "4", "-shortest", "-c:v", "mpeg4", "-q:v", "5",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", $sampleVideo
)
Invoke-CheckedFfmpeg @(
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
  "-t", "3", "-c:a", "pcm_s16le", $sampleAudio
)

$fourMegabytes = 4MB
$files = @(
  (Assert-FileRange -Path $smallImage -MinimumBytes 1 -MaximumBytes ($fourMegabytes - 1)),
  (Assert-FileRange -Path $largeImage -MinimumBytes ($fourMegabytes + 1)),
  (Assert-FileRange -Path $sampleVideo -MinimumBytes 1),
  (Assert-FileRange -Path $sampleAudio -MinimumBytes 1)
)

$fixtureRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\tests\fixtures")).Path
$minimalProjectPath = Join-Path $fixtureRoot "minimal-project.json"
$rejectedWorkflowPath = Join-Path $fixtureRoot "rejected-comfyui-editor-workflow.json"
$minimalProject = Get-Content -LiteralPath $minimalProjectPath -Raw -Encoding UTF8 | ConvertFrom-Json
$rejectedWorkflow = Get-Content -LiteralPath $rejectedWorkflowPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($minimalProject.nodes.Count -lt 1 -or $minimalProject.nodes[0].kind -ne "text") {
  throw "The minimal project fixture has an invalid structure: $minimalProjectPath"
}
if ($null -eq $rejectedWorkflow.last_node_id -or $rejectedWorkflow.nodes[0].id -isnot [int]) {
  throw "The rejected ComfyUI UI fixture has an invalid structure: $rejectedWorkflowPath"
}

Write-Host "[PASS] Desktop acceptance fixtures were generated offline and size-checked."
Write-Host "ffmpeg: $script:Ffmpeg"
$files | Select-Object Name, @{Name = "Bytes"; Expression = { $_.Length } }, FullName | Format-Table -AutoSize
Write-Host "Minimal project: $minimalProjectPath"
Write-Host "ComfyUI UI JSON that the project-open entry must reject: $rejectedWorkflowPath"
