# KRX 1,000대 종목 (KOSPI 500 + KOSDAQ 500) 65거래일 일봉 및 WICS 섹터 로컬 자동 최신화 스크립트 (Windows PowerShell)
$ErrorActionPreference = "Stop"
$headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }

$etfBrands = @(
    "KODEX", "TIGER", "KBSTAR", "RISE", "ACE", "SOL", "HANARO",
    "KOSEF", "ARIRANG", "PLUS", "TIMEFOLIO", "WOORI", "히어로즈",
    "마이티", "파워", "대신343", "엔투", "코세프", "에셋플러스", "UNICORN",
    "VITA", "TREX", "HK", "마이다스", "더제이", "글로벌X", "옥토", "원큐",
    "1Q", "ITF", "네비게이터", "스마트", "포커스", "밸류", "신한", "미래에셋",
    "삼성", "키움", "한투", "투모로우"
)

function Test-IsCommonStock($item) {
    $code = [string]$item.itemCode
    $name = [string]$item.stockName
    $etnCode = [string]$item.stockEndType
    if ($etnCode -and $etnCode -ne "stock") { return $false }
    if ($code -notmatch "^[0-9]{5}0$") { return $false }
    foreach ($b in $etfBrands) {
        if ($name.StartsWith("$b ")) { return $false }
    }
    if ($name -match "스팩|제[0-9]+호|리츠|인프라|맥쿼리|우B|우C|우선주|채권|선물|레버리지|인버스|커버드콜|액티브|합성|ETN|ETF") { return $false }
    if ($name -match "(우|우B|우C|\(전환\))$") { return $false }
    return $true
}

function Format-McapText([string]$rawEok) {
    $clean = $rawEok -replace ",", ""
    $num = 0L
    if ([long]::TryParse($clean, [ref]$num)) {
        if ($num -ge 10000) {
            $jo = [math]::Floor($num / 10000)
            $rem = $num % 10000
            if ($rem -gt 0) { return ("{0:N0}조 {1:N0}억원" -f $jo, $rem) }
            else { return ("{0:N0}조원" -f $jo) }
        }
        return ("{0:N0}억원" -f $num)
    }
    return "$rawEok 억원"
}

function Normalize-SectorName([string]$rawName) {
    switch -Regex ($rawName) {
        "반도체" { return "반도체·장비" }
        "전기제품|에너지장비|축전지|2차전지" { return "2차전지·전력기기" }
        "제약|생물공학|건강관리|생명과학|의료" { return "제약·바이오·헬스" }
        "은행|증권|보험|카드|금융|창업투자|투신|리츠" { return "금융·은행·증권" }
        "자동차" { return "자동차·부품" }
        "조선|우주항공|국방|방산" { return "조선·방산·항공" }
        "기계|건설|건축|엔지니어링|시멘트|상사|무역" { return "기계·건설·인프라" }
        "양방향|미디어|인터넷|게임|소프트웨어|IT서비스|방송|엔터|광고|영화|출판|교육" { return "IT·플랫폼·게임·엔터" }
        "전자장비|디스플레이|핸드셋|전기장비|컴퓨터|통신장비|사무용전자|전자제품|IT하드웨어" { return "IT하드웨어·전자부품" }
        "화학|철강|비철금속|석유|가스|종이|목재|포장재|광물|에너지소재" { return "화학·철강·에너지소재" }
        "화장품|섬유|의류|백화점|소매|유통|가정용|가구|호텔|레저|생물|소비재" { return "화장품·유통·소비재" }
        "식품|음료|담배|농업|식료" { return "음식료·필수소비재" }
        "해운|항공|육상|운수|운송|물류" { return "해운·항공·운송" }
        "유틸리티|통신" { return "통신·유틸리티" }
        "복합기업|지주" { return "지주·복합기업" }
        default { return "기계·건설·인프라" }
    }
}

function Get-Top500ByMarket([string]$marketName, [int]$targetCount = 500) {
    $collected = @()
    $seen = @{}
    $page = 1
    while ($collected.Count -lt $targetCount -and $page -le 18) {
        $url = "https://m.stock.naver.com/api/stocks/marketValue/$marketName`?page=$page&pageSize=100"
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 10
        if (-not $resp.stocks -or $resp.stocks.Count -eq 0) { break }
        foreach ($st in $resp.stocks) {
            $code = [string]$st.itemCode
            if ($seen.ContainsKey($code)) { continue }
            if (Test-IsCommonStock $st) {
                $seen[$code] = $true
                $rank = $collected.Count + 1
                $collected += [PSCustomObject]@{
                    code = $code
                    name = [string]$st.stockName
                    market = $marketName
                    mcapRank = "$marketName 시총 $($rank)위"
                    mcapText = Format-McapText ([string]$st.marketValue)
                }
                if ($collected.Count -ge $targetCount) { break }
            }
        }
        $page++
    }
    return $collected
}

Write-Host "1. KOSPI 500 + KOSDAQ 500 시가총액 상위 종목 수집 중..."
$kospi = Get-Top500ByMarket "KOSPI" 500
$kosdaq = Get-Top500ByMarket "KOSDAQ" 500
$universe = $kospi + $kosdaq

Write-Host "2. WICS 79개 업종(섹터) 분류 수집 중..."
$indResp = Invoke-RestMethod -Uri "https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100" -Headers $headers -TimeoutSec 10
$codeToSector = @{}
$codeToSubSector = @{}

$poolSec = [RunspaceFactory]::CreateRunspacePool(1, 16)
$poolSec.Open()
$secJobs = @()
$secBlock = {
    param($no, $name, $totalCount)
    $h = @{ "User-Agent" = "Mozilla/5.0" }
    $pages = [Math]::Max(1, [Math]::Ceiling([double]$totalCount / 100.0))
    $arr = @()
    for ($p = 1; $p -le $pages; $p++) {
        try {
            $r = Invoke-RestMethod -Uri "https://m.stock.naver.com/api/stocks/industry/$no`?page=$p&pageSize=100" -Headers $h -TimeoutSec 8
            foreach ($st in $r.stocks) {
                $arr += [PSCustomObject]@{ code = [string]$st.itemCode; subSector = [string]$name }
            }
        } catch {}
    }
    return $arr
}
foreach ($g in $indResp.groups) {
    $ps = [PowerShell]::Create().AddScript($secBlock).AddArgument($g.no).AddArgument($g.name).AddArgument($g.totalCount)
    $ps.RunspacePool = $poolSec
    $secJobs += [PSCustomObject]@{ Pipe = $ps; Handle = $ps.BeginInvoke() }
}
foreach ($j in $secJobs) {
    try {
        foreach ($it in $j.Pipe.EndInvoke($j.Handle)) {
            if ($it -and $it.code) {
                $codeToSubSector[$it.code] = $it.subSector
                $codeToSector[$it.code] = Normalize-SectorName $it.subSector
            }
        }
    } catch {}
    $j.Pipe.Dispose()
}
$poolSec.Close()
$poolSec.Dispose()

Write-Host "3. 1,000종목 65거래일 일봉 데이터 병렬 수집 중..."
$pool = [RunspaceFactory]::CreateRunspacePool(1, 20)
$pool.Open()
$jobs = @()
$candleBlock = {
    param($st)
    $code = $st.code
    $url = "https://fchart.stock.naver.com/sise.nhn?symbol=$code&timeframe=day&count=65&requestType=0"
    for ($try = 0; $try -lt 3; $try++) {
        try {
            $req = [System.Net.HttpWebRequest]::Create($url)
            $req.UserAgent = "Mozilla/5.0"
            $req.Timeout = 7000
            $resp = $req.GetResponse()
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
            $xmlText = $sr.ReadToEnd()
            $sr.Close()
            $resp.Close()
            $matches = [regex]::Matches($xmlText, 'data="([0-9]{8})\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)"')
            $candles = @()
            foreach ($m in $matches) {
                $dt = $m.Groups[1].Value
                $o = [long]$m.Groups[2].Value; $h = [long]$m.Groups[3].Value; $l = [long]$m.Groups[4].Value; $c = [long]$m.Groups[5].Value; $v = [long]$m.Groups[6].Value
                if ($c -le 0) { continue }
                if ($o -le 0) { $o = $c; $h = $c; $l = $c }
                $mm = [int]$dt.Substring(4, 2); $dd = [int]$dt.Substring(6, 2)
                $candles += , @("$mm/$dd", $o, $h, $l, $c, $v)
            }
            if ($candles.Count -ge 15) {
                return [PSCustomObject]@{ code = $code; candles = $candles }
            }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    return $null
}

foreach ($st in $universe) {
    $ps = [PowerShell]::Create().AddScript($candleBlock).AddArgument($st)
    $ps.RunspacePool = $pool
    $jobs += [PSCustomObject]@{ Stock = $st; Pipe = $ps; Handle = $ps.BeginInvoke() }
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("// KRX 1,000대 종목 (KOSPI 시총 상위 500종목 + KOSDAQ 시총 상위 500종목 = 총 1,000종목) 실제 65거래일 일봉 및 업종(섹터) 데이터")
[void]$sb.Append("const REAL_STOCK_UNIVERSE = [")

$saved = 0
foreach ($j in $jobs) {
    try {
        $res = $j.Pipe.EndInvoke($j.Handle)
        $resObj = if ($res -is [array]) { $res[0] } else { $res }
        if ($resObj -and $resObj.candles) {
            $st = $j.Stock
            $sec = if ($codeToSector.ContainsKey($st.code)) { $codeToSector[$st.code] } else { "IT하드웨어·전자부품" }
            $sub = if ($codeToSubSector.ContainsKey($st.code)) { $codeToSubSector[$st.code] } else { "전자장비와기기" }
            if ($saved -gt 0) { [void]$sb.Append(",") }
            $cJson = ConvertTo-Json $resObj.candles -Compress -Depth 3
            $itemJson = '{"code":"' + $st.code + '","name":"' + ($st.name -replace '"','\"') + '","market":"' + $st.market + '","sector":"' + $sec + '","subSector":"' + $sub + '","mcapRank":"' + $st.mcapRank + '","mcapText":"' + $st.mcapText + '","rawCandles":' + $cJson + '}'
            [void]$sb.Append($itemJson)
            $saved++
        }
    } catch {}
    $j.Pipe.Dispose()
}
$pool.Close()
$pool.Dispose()
[void]$sb.AppendLine("];")

$outPath = Join-Path (Split-Path $PSScriptRoot -Parent) "stocks_data.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outPath, $sb.ToString(), $utf8NoBom)
Write-Host "4. 완료! 총 $saved 개 종목 최신 일봉 및 섹터 데이터가 $outPath 에 저장되었습니다."
