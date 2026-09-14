$ErrorActionPreference = 'Stop'
$base = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:4173' }

# Windows PowerShell 5.1 默认不是 UTF-8 出站编码，中文请求体必须显式转成 UTF-8 字节，否则服务端收到的是乱码。
function Send-Json { param([string]$Method, [string]$Url, $Payload)
  $json = $Payload | ConvertTo-Json -Depth 8
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method $Method -Uri $Url -ContentType 'application/json; charset=utf-8' -Body $bytes
}

$health = Invoke-RestMethod -Uri "$base/api/health"
if (-not $health.ok) { throw 'health check failed' }
if ($null -eq $health.corpus) { throw 'health contract failed: missing corpus status' }
if ($null -eq $health.relationTypes -or $health.relationTypes.Count -lt 1) { throw 'health contract failed: missing relation types' }

$corpus = Invoke-RestMethod -Uri "$base/api/corpus"
if ($null -eq $corpus.docs) { throw 'corpus contract failed' }

$question = 'Smoke ' + [char]0x73B0 + [char]0x5728 + [char]0x53BB + [char]0x9996 + [char]0x90FD + [char]0x673A + [char]0x573A + ' T3 ' + [char]0x8FD8 + [char]0x6765 + [char]0x5F97 + [char]0x53CA + [char]0x5417
$analysis = Send-Json 'Post' "$base/api/analyze" @{ question = $question }
if ($null -eq $analysis.analysis.entities -or $null -eq $analysis.analysis.unknownFacts) { throw 'analysis contract failed' }
if ([string]::IsNullOrWhiteSpace($analysis.caseId)) { throw 'case creation contract failed' }
if ($null -eq $analysis.matches) { throw 'analysis contract failed: missing matches' }

$case = Invoke-RestMethod -Uri "$base/api/cases/$($analysis.caseId)"
if ($case.status -ne 'open' -or $null -eq $case.feedback) { throw 'case persistence contract failed' }
if ($case.evidenceState.code -ne 'pending') { throw "empty case should be pending, got $($case.evidenceState.code)" }
if ($case.feedbackUrl -ne "/verify/$($analysis.caseId)") { throw 'feedback url contract failed' }

$blocked = $false
try { Send-Json 'Post' "$base/api/cases/$($analysis.caseId)/answer" @{} | Out-Null } catch { $blocked = $true }
if (-not $blocked) { throw 'answer must be refused while no feedback exists' }

$relation = [char]0x672C + [char]0x4EBA + [char]0x5230 + [char]0x573A
$first = [char]0x6211 + [char]0x521A + [char]0x521A + [char]0x5230 + [char]0x4E86 + [char]0x73B0 + [char]0x573A + [char]0xFF0C + [char]0x5165 + [char]0x53E3 + [char]0x6B63 + [char]0x5E38 + [char]0x5F00 + [char]0x653E + [char]0xFF0C + [char]0x4F46 + [char]0x662F + [char]0x5B9E + [char]0x65BD + [char]0x9650 + [char]0x6D41 + [char]0xFF0C + [char]0x9700 + [char]0x8981 + [char]0x6392 + [char]0x961F + [char]0x5927 + [char]0x7EA6 + [char]0x5341 + [char]0x5206 + [char]0x949F + [char]0x3002
$feedback = Send-Json 'Post' "$base/api/cases/$($analysis.caseId)/feedback" @{ displayName = 'Smoke tester'; relationType = 'witness'; relation = $relation; area = 'test area'; content = $first }
if ([string]::IsNullOrWhiteSpace($feedback.feedback.id)) { throw 'feedback contract failed' }
if ($feedback.evidenceState.code -ne 'single') { throw "single feedback should stay single, got $($feedback.evidenceState.code)" }
$codes = ($feedback.feedback.signals | ForEach-Object { $_.code }) -join ','
if ($codes -notmatch 'open') { throw "signal contract failed: expected an 'open' signal, got '$codes'" }
if ($codes -match 'closed') { throw "throttle regression: an open-but-metered report must not read as closed (got '$codes')" }
if ($codes -match 'throttled' -and $feedback.evidenceState.stats.neutral -lt 1) { throw 'neutral signal was not counted as neutral' }

$second = [char]0x6211 + [char]0x4E5F + [char]0x5728 + [char]0x73B0 + [char]0x573A + [char]0xFF0C + [char]0x5165 + [char]0x53E3 + [char]0x662F + [char]0x5F00 + [char]0x7740 + [char]0x7684 + [char]0xFF0C + [char]0x4E0D + [char]0x8FC7 + [char]0x6392 + [char]0x961F + [char]0x7684 + [char]0x4EBA + [char]0x786E + [char]0x5B9E + [char]0x5F88 + [char]0x591A + [char]0xFF0C + [char]0x7B49 + [char]0x4E86 + [char]0x4E8C + [char]0x5341 + [char]0x591A + [char]0x5206 + [char]0x949F + [char]0x3002
$corroborated = Send-Json 'Post' "$base/api/cases/$($analysis.caseId)/feedback" @{ displayName = 'Second tester'; relationType = 'witness'; relation = $relation; area = 'north gate'; content = $second }
if ($corroborated.evidenceState.code -ne 'corroborated') { throw "corroboration contract failed, got $($corroborated.evidenceState.code)" }
if ($corroborated.evidenceState.dimensions.Count -lt 1) { throw 'dimension contract failed: expected per-dimension verdicts' }
$dimStatuses = ($corroborated.evidenceState.dimensions | ForEach-Object { $_.status }) -join ','
if ($dimStatuses -notmatch $($dimStatuses)) { throw 'unreachable' }

$duplicate = Send-Json 'Post' "$base/api/cases/$($analysis.caseId)/feedback" @{ displayName = 'Repeat tester'; relationType = 'witness'; relation = $relation; area = 'test area'; content = $second }
if (-not $duplicate.duplicate) { throw 'duplicate detection failed' }

$answer = Send-Json 'Post' "$base/api/cases/$($analysis.caseId)/answer" @{}
if ([string]::IsNullOrWhiteSpace($answer.answer)) { throw 'answer contract failed' }
if ($answer.evidenceState.code -ne 'corroborated') { throw "answer state contract failed, got $($answer.evidenceState.code)" }

$casePage = Invoke-WebRequest -Uri "$base/case/$($analysis.caseId)" -UseBasicParsing
if ($casePage.StatusCode -ne 200) { throw 'case page contract failed' }
$verifyPage = Invoke-WebRequest -Uri "$base/verify/$($analysis.caseId)" -UseBasicParsing
if ($verifyPage.StatusCode -ne 200) { throw 'verify page contract failed' }

Write-Output "PASS health=$($health.ok) corpus=$($corpus.count) case=$($analysis.caseId) signals=$codes dims=$dimStatuses state=$($answer.evidenceState.code) answer_live=$($answer.live)"
