# Export a .pptx or .docx to PDF with the installed Microsoft Office (exact rendering for the in-app viewer).
# Office is only closed afterwards if this script started it, so the user's open windows are never touched.
param([string]$Kind, [string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
$missing = [System.Reflection.Missing]::Value

if ($Kind -eq 'pptx') {
  $running = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
  $app = New-Object -ComObject PowerPoint.Application
  try {
    # ReadOnly, not Untitled, no window
    $pres = $app.Presentations.Open($In, -1, 0, 0)
    try {
      try {
        # PDF, print quality, hidden slides included so page N is always slide N
        $pres.ExportAsFixedFormat($Out, 2, 2, 0, 1, 1, -1, $missing, 1, '', $false, $true, $true, $true, $false)
      } catch {
        $pres.SaveAs($Out, 32)
      }
    } finally { $pres.Close() }
  } finally {
    if (-not $running) { $app.Quit() }
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
  }
} elseif ($Kind -eq 'docx') {
  $running = @(Get-Process WINWORD -ErrorAction SilentlyContinue).Count -gt 0
  $app = New-Object -ComObject Word.Application
  try {
    if (-not $running) { $app.Visible = $false }
    $app.DisplayAlerts = 0
    # no conversion prompt, read-only, not added to recent files
    $doc = $app.Documents.Open($In, $false, $true, $false)
    try {
      # PDF, print quality, whole document, with heading bookmarks (the chapter list) and structure tags
      $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
    } finally { $doc.Close(0) }
  } finally {
    if (-not $running) { $app.Quit() }
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
  }
} else {
  throw "Unknown kind $Kind"
}
