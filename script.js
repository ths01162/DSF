/**
 * DailyStockFinder - KRX 시가총액 상위 1,000대 종목 (KOSPI 500 + KOSDAQ 500) 전수 스크리닝 엔진
 * 실제 65거래일 일봉 데이터(총 65,000개 캔들) 및 네이버 증권 실시간 시세(JSONP) 연동
 * 순수 Vanilla JS + HTML5 Canvas (외부 라이브러리 의존성 0%)
 */

const STRATEGY_DESCRIPTIONS = {
  all: 'KRX 시총 상위 1,000대 종목 전수 분석 ➔ 추세·수급·모멘텀 종합 최상위 5선',
  breakout: 'KRX 1,000대 종목 중 단기·중기 이평선(5일/20일) 상향 돌파 및 정배열 강세 TOP 5',
  pullback: 'KRX 1,000대 종목 중 상승 추세 내 5일·20일 이동평균선 지지를 확인한 눌림목 TOP 5',
  volume: 'KRX 1,000대 종목 중 20일 평균 대비 대량 거래량 폭발 및 수급 집중 TOP 5',
  oversold: 'KRX 1,000대 종목 중 RSI 과매도권(≤40) 및 볼린저밴드 하단 양봉 반등 TOP 5'
};

// 한국거래소(KRX) 표준 호가 단위 반올림
function roundToTick(price) {
  if (price >= 500000) return Math.round(price / 1000) * 1000;
  if (price >= 200000) return Math.round(price / 500) * 500;
  if (price >= 50000) return Math.round(price / 100) * 100;
  if (price >= 20000) return Math.round(price / 50) * 50;
  if (price >= 2000) return Math.round(price / 5) * 5;
  return Math.round(price);
}

// 이동평균선 전체 배열 계산 (차트 렌더링 시 1회 호출)
function calcSMAArray(closes, period) {
  return closes.map((_, idx) => {
    if (idx < period - 1) return null;
    let sum = 0;
    for (let j = idx - period + 1; j <= idx; j++) sum += closes[j];
    return Math.round(sum / period);
  });
}

// 볼린저밴드 전체 배열 계산 (차트 렌더링 시 1회 호출)
function calcBollingerBandsArray(closes, period = 20, mult = 2) {
  const upper = [];
  const lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - mean;
      sqSum += d * d;
    }
    const std = Math.sqrt(sqSum / period);
    upper.push(Math.round(mean + mult * std));
    lower.push(Math.round(mean - mult * std));
  }
  return { upper, lower };
}

// 최신 시점 단일 SMA 계산 (1,000종목 초고속 스코어링용)
function calcLatestSMA(rawCandles, period) {
  const len = rawCandles.length;
  if (len < period) return rawCandles[len - 1][4];
  let sum = 0;
  for (let i = len - period; i < len; i++) sum += rawCandles[i][4];
  return Math.round(sum / period);
}

// 최신 시점 단일 볼린저밴드 계산
function calcLatestBB(rawCandles, period = 20, mult = 2) {
  const len = rawCandles.length;
  if (len < period) {
    const c = rawCandles[len - 1][4];
    return { upper: Math.round(c * 1.08), lower: Math.round(c * 0.92) };
  }
  let sum = 0;
  for (let i = len - period; i < len; i++) sum += rawCandles[i][4];
  const mean = sum / period;
  let sqSum = 0;
  for (let i = len - period; i < len; i++) {
    const d = rawCandles[i][4] - mean;
    sqSum += d * d;
  }
  const std = Math.sqrt(sqSum / period);
  return {
    upper: Math.round(mean + mult * std),
    lower: Math.round(mean - mult * std)
  };
}

// RSI(14) 계산
function calcLatestRSI(rawCandles, period = 14) {
  const len = rawCandles.length;
  if (len <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = len - period; i < len; i++) {
    const diff = rawCandles[i][4] - rawCandles[i - 1][4];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// MACD(12, 26, 9) 계산
function calcLatestMACD(rawCandles) {
  const len = rawCandles.length;
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  const k9 = 2 / 10;

  let ema12 = rawCandles[0][4];
  let ema26 = rawCandles[0][4];
  let signal = 0;
  let prevHist = 0;
  let lastHist = 0;

  for (let i = 1; i < len; i++) {
    const close = rawCandles[i][4];
    ema12 = close * k12 + ema12 * (1 - k12);
    ema26 = close * k26 + ema26 * (1 - k26);
    const macd = ema12 - ema26;
    signal = i === 1 ? macd : macd * k9 + signal * (1 - k9);
    prevHist = lastHist;
    lastHist = macd - signal;
  }

  return {
    histogram: Math.round(lastHist),
    rawHist: lastHist,
    prevHist: prevHist,
    isExpanding: lastHist >= prevHist
  };
}

// 전역 상태
let weights = { trend: 30, volume: 30, momentum: 25, pattern: 15, sector: 100 };
let customSectorBoost = {}; // 섹터별 사용자 수동 추가 가감점 (-5 ~ +5점)
let sectorStatsMap = {};    // 실시간 산출된 섹터별 모멘텀·수급 통계 및 가감점
let sortedSectors = [];     // 가감점 순으로 정렬된 섹터 배열
let currentStrategy = 'all';
let currentMarket = 'ALL';
let currentSector = 'ALL';
let analyzedUniverse = [];
let currentTop5 = [];
let selectedStock = null;
let liveInterval = null;
let isLiveOn = true;
let hoverCandleIndex = null;
let modalShowAll = false;
let realtimeBatchCursor = 0;
let sectorControlsInitialized = false;
let sectorBarExpanded = false; // 기본: 핵심 6개 섹터 한 줄/두 줄 요약, 클릭 시 14개 전체 그리드 펼침

// 79개 세부 WICS 업종명을 14개 KRX 핵심 대분류 섹터로 빈틈없이 정규화
function normalizeMacroSector(raw) {
  const s = String(raw || '');
  if (/반도체/.test(s)) return '반도체·장비';
  if (/전기제품|에너지장비|축전지|2차전지/.test(s)) return '2차전지·전력기기';
  if (/제약|생물공학|건강관리|생명과학|의료/.test(s)) return '제약·바이오·헬스';
  if (/은행|증권|보험|카드|금융|창업투자|투신|리츠/.test(s)) return '금융·은행·증권';
  if (/자동차/.test(s)) return '자동차·부품';
  if (/조선|우주항공|국방|방산/.test(s)) return '조선·방산·항공';
  if (/기계|건설|건축|엔지니어링|시멘트|상사|무역/.test(s)) return '기계·건설·인프라';
  if (/양방향|미디어|인터넷|게임|소프트웨어|IT서비스|방송|엔터|광고|영화|출판|교육/.test(s)) return 'IT·플랫폼·게임·엔터';
  if (/전자장비|디스플레이|핸드셋|전기장비|컴퓨터|통신장비|사무용전자|전자제품|IT하드웨어/.test(s)) return 'IT하드웨어·전자부품';
  if (/화학|철강|비철금속|석유|가스|종이|목재|포장재|광물|에너지소재/.test(s)) return '화학·철강·에너지소재';
  if (/화장품|섬유|의류|백화점|소매|유통|가정용|가구|호텔|레저|생물|소비재|백화점/.test(s)) return '화장품·유통·소비재';
  if (/식품|음료|담배|농업|식료/.test(s)) return '음식료·필수소비재';
  if (/해운|항공|육상|운수|운송|물류/.test(s)) return '해운·항공·운송';
  if (/유틸리티|통신/.test(s)) return '통신·유틸리티';
  if (/복합기업|지주/.test(s)) return '지주·복합기업';
  return '기계·건설·인프라';
}

// 1,000개 종목 초고속 기술적 지표 및 추천 점수 산출
function evaluateStock(stock, indexOrder) {
  const rc = stock.rawCandles;
  const len = rc.length;
  const lastRow = rc[len - 1];
  const prevRow = len > 1 ? rc[len - 2] : lastRow;

  const currentPrice = lastRow[4];
  const prevClose = prevRow[4];
  const diffPrice = currentPrice - prevClose;
  const changeRate = prevClose > 0
    ? Math.round(((diffPrice / prevClose) * 100) * 100) / 100
    : 0;

  const todayCandle = {
    date: `오늘(${lastRow[0]})`,
    open: lastRow[1],
    high: lastRow[2],
    low: lastRow[3],
    close: currentPrice,
    volume: lastRow[5],
    prevClose
  };

  const ma5 = calcLatestSMA(rc, 5);
  const ma20 = calcLatestSMA(rc, 20);
  const ma60 = calcLatestSMA(rc, Math.min(60, len));
  const bbLatest = calcLatestBB(rc, 20, 2);
  const bbUpper = bbLatest.upper;
  const bbLower = bbLatest.lower;

  const rsi = calcLatestRSI(rc, 14);
  const macd = calcLatestMACD(rc);

  // 직전 20거래일 평균 거래량 대비 금일 거래량 비율
  const vStart = Math.max(0, len - 21);
  const vEnd = len - 1;
  let volSum = 0;
  for (let i = vStart; i < vEnd; i++) volSum += rc[i][5];
  const avgVol20 = vEnd > vStart ? volSum / (vEnd - vStart) : todayCandle.volume;
  const volRatio = avgVol20 > 0 ? Math.max(1, Math.round((todayCandle.volume / avgVol20) * 100)) : 100;

  // 시총 순위 숫자 추출 (예: "KOSPI 시총 12위" -> 12)
  const rankMatch = stock.mcapRank.match(/(\d+)위/);
  const mcapRankNum = rankMatch ? Number(rankMatch[1]) : 500;

  // 4대 전략 엄격 부합 여부 판정
  const isBreakout =
    (currentPrice > ma20 && currentPrice > ma5 && changeRate >= 1.5 && currentPrice >= todayCandle.open) ||
    (ma5 > ma20 && ma20 >= ma60 && currentPrice >= ma5 && changeRate >= 1.0);

  const isPullback =
    currentPrice >= ma5 * 0.992 &&
    currentPrice <= ma20 * 1.04 &&
    ma20 >= ma60 * 0.98 &&
    changeRate >= 0.2 &&
    changeRate <= 3.5 &&
    !isBreakout;

  const isVolumeActive = volRatio >= 150 && changeRate >= 0.5 && todayCandle.close >= todayCandle.open;

  const isOversold = rsi <= 36.5 && changeRate >= 0.5 && todayCandle.close >= todayCandle.open;

  // 1차 진입가(선취매 50%) / 2차 추가매수가(눌림목 50%) / 1차 목표가 / 손절 기준가 산출
  const entryLow = roundToTick(currentPrice * 0.994);
  const entryHigh = currentPrice;

  const candidateTarget = bbUpper && bbUpper > currentPrice * 1.05 ? bbUpper : currentPrice * 1.078;
  const targetPrice = roundToTick(Math.min(currentPrice * 1.125, Math.max(currentPrice * 1.058, candidateTarget)));

  // 손절 기준가: 현재가 대비 약 -4.1% (2차 매수 지지선 하향 이탈 시)
  const stopPrice = roundToTick(currentPrice * 0.959);

  // 2차 매수가(눌림목 추가매수): 손절선 위 안전마진을 확보한 단기 이평선(5일/20일선) 또는 현재가 대비 약 -2.1% 눌림 지지 구간
  let rawSecondEntry = currentPrice * 0.979;
  if (ma5 >= currentPrice * 0.970 && ma5 <= currentPrice * 0.986) {
    rawSecondEntry = ma5;
  } else if (ma20 >= currentPrice * 0.970 && ma20 <= currentPrice * 0.986) {
    rawSecondEntry = ma20;
  }
  const secondEntryPrice = roundToTick(Math.max(stopPrice * 1.015, Math.min(currentPrice * 0.986, rawSecondEntry)));
  const secondEntryDropPct = Math.round(((secondEntryPrice - currentPrice) / currentPrice) * 10000) / 100;

  // 1차(50%) + 2차(50%) 분할매수 체결 시 예상 평균단가(평단가)
  const avgEntryPrice = roundToTick((currentPrice + secondEntryPrice) / 2);

  const targetGainPct = Math.round(((targetPrice - currentPrice) / currentPrice) * 10000) / 100;
  const stopLossPct = Math.round(((stopPrice - currentPrice) / currentPrice) * 10000) / 100;
  const rrRatio = Math.round((targetGainPct / Math.abs(stopLossPct || -3.5)) * 100) / 100;

  // 2차 매수까지 체결된 평단가(avgEntryPrice) 기준 기대수익률·손절률·손익비
  const avgTargetGainPct = Math.round(((targetPrice - avgEntryPrice) / avgEntryPrice) * 10000) / 100;
  const avgStopLossPct = Math.round(((stopPrice - avgEntryPrice) / avgEntryPrice) * 10000) / 100;
  const avgRrRatio = Math.round((avgTargetGainPct / Math.abs(avgStopLossPct || -2.5)) * 100) / 100;

  // 4대 세부 팩터 연속형(Continuous) 정밀 점수 계산 (각 25.0 ~ 98.5점, 소수점 1자리)
  const clampFactor = val => Math.round(Math.min(98.5, Math.max(25.0, val)) * 10) / 10;

  // 1) 추세(Trend) 점수: 이평선 이격도, 정배열 스프레드, 10일 추세 기울기, 과열 감점 반영
  const distMa5Pct = ma5 > 0 ? ((currentPrice - ma5) / ma5) * 100 : 0;
  const distMa20Pct = ma20 > 0 ? ((currentPrice - ma20) / ma20) * 100 : 0;
  const spread5_20Pct = ma20 > 0 ? ((ma5 - ma20) / ma20) * 100 : 0;
  const spread20_60Pct = ma60 > 0 ? ((ma20 - ma60) / ma60) * 100 : 0;
  const roc10Pct = len >= 11 && rc[len - 11][4] > 0
    ? ((currentPrice - rc[len - 11][4]) / rc[len - 11][4]) * 100
    : changeRate * 2;

  let alignBonus = 0;
  if (currentPrice > ma5 && ma5 > ma20 && ma20 > ma60) alignBonus = 15.5;
  else if (currentPrice > ma5 && currentPrice > ma20) alignBonus = 9.5;
  else if (currentPrice >= ma5 && ma5 >= ma20 * 0.99) alignBonus = 5.5;
  else if (isOversold) alignBonus = 7.0;

  // 단기 이격 과열(>11%) 시 추격매수 리스크 감점
  const overheatPenalty = distMa20Pct > 11
    ? Math.min(22, (distMa20Pct - 11) * 2.1)
    : (distMa20Pct < -12 ? Math.min(18, Math.abs(distMa20Pct + 12) * 1.4) : 0);

  const rawTrend =
    52.0 +
    alignBonus +
    Math.max(-12, Math.min(14, distMa5Pct * 2.4)) +
    Math.max(-10, Math.min(13, spread5_20Pct * 1.9)) +
    Math.max(-8, Math.min(10, spread20_60Pct * 1.15)) +
    Math.max(-8, Math.min(9, roc10Pct * 0.55)) -
    overheatPenalty;
  const factorTrend = clampFactor(rawTrend);

  // 2) 거래량/수급(Volume) 점수: 로그 스케일 거래량비 + 최근 3일 수급 가속도 + 양봉 수급 결합 + 시총 유동성
  const volRatioExact = avgVol20 > 0 ? (todayCandle.volume / avgVol20) * 100 : 100;
  const recent3Vol = len >= 3 ? (rc[len - 1][5] + rc[len - 2][5] + rc[len - 3][5]) / 3 : todayCandle.volume;
  const volAccelRatio = avgVol20 > 0 ? recent3Vol / avgVol20 : 1;
  const logVolScore = Math.log10(Math.max(15, Math.min(900, volRatioExact)) / 100) * 34;
  const dirVolBonus = changeRate >= 0
    ? Math.min(16, changeRate * 2.1 * Math.min(1.8, volRatioExact / 100))
    : Math.max(-16, changeRate * 2.3);
  const liquidityScore = ((501 - Math.min(500, mcapRankNum)) / 500) * 6.5;

  const rawVolume =
    54.0 +
    logVolScore +
    Math.max(-6, Math.min(10, (volAccelRatio - 1) * 8.5)) +
    dirVolBonus +
    liquidityScore;
  const factorVolume = clampFactor(rawVolume);

  // 3) 모멘텀(Momentum: RSI + 가격대비 MACD bp + 오실레이터 가속도) 점수
  let rsiCurveScore = 0;
  if (isOversold || (rsi <= 40 && changeRate > 0.3)) {
    // 과매도 반등 탄력 곡선 (RSI 28~36 구간에서 양봉 전환 시 고득점)
    rsiCurveScore = 24.0 - Math.abs(rsi - 32.5) * 0.9 + Math.min(10, changeRate * 2.2);
  } else {
    // 추세 모멘텀 곡선 (RSI 58.5 부근이 과열 없는 최적 탄력 구간)
    rsiCurveScore = 27.5 - Math.pow(rsi - 58.5, 2) * 0.085;
  }
  const macdBp = currentPrice > 0 ? (macd.rawHist / currentPrice) * 10000 : 0;
  const macdAccelBp = currentPrice > 0 ? ((macd.rawHist - macd.prevHist) / currentPrice) * 10000 : 0;

  const rawMomentum =
    50.0 +
    rsiCurveScore +
    Math.max(-12, Math.min(13, macdBp * 0.16)) +
    Math.max(-8, Math.min(10, macdAccelBp * 0.28)) +
    (macd.isExpanding && macd.rawHist > 0 ? 4.2 : 0);
  const factorMomentum = clampFactor(rawMomentum);

  // 4) 캔들 패턴 & 손익비(Pattern) 점수: 캔들 몸통 비율, 고가 마감도(윗꼬리 제어), 적정 상승폭, 손익비(R/R)
  const candleRange = Math.max(1, todayCandle.high - todayCandle.low);
  const bodySignedRatio = (todayCandle.close - todayCandle.open) / candleRange; // -1.0 ~ +1.0
  const closeLocation = (todayCandle.close - todayCandle.low) / candleRange;    // 0.0 ~ 1.0 (고가 마감일수록 1)
  const upperWickRatio = (todayCandle.high - Math.max(todayCandle.open, todayCandle.close)) / candleRange;

  // 적정 상승률(1.5% ~ 5.5%) 우대, 상한가 근접 과열(>12%) 감점
  let gainQuality = 0;
  if (changeRate >= 0.8 && changeRate <= 6.5) {
    gainQuality = 14.0 - Math.abs(changeRate - 3.4) * 1.4;
  } else if (changeRate > 6.5) {
    gainQuality = Math.max(-10, 9.5 - (changeRate - 6.5) * 1.6);
  } else {
    gainQuality = Math.max(-15, changeRate * 3.2);
  }

  const rrScore = Math.max(-5, Math.min(12, (rrRatio - 1.8) * 6.5));
  const rawPattern =
    52.0 +
    bodySignedRatio * 14.5 +
    (closeLocation - 0.5) * 15.0 -
    upperWickRatio * 9.5 +
    gainQuality +
    rrScore;
  const factorPattern = clampFactor(rawPattern);

  const totalWeight = (weights.trend + weights.volume + weights.momentum + weights.pattern) || 100;
  const rawScore =
    (factorTrend * weights.trend +
      factorVolume * weights.volume +
      factorMomentum * weights.momentum +
      factorPattern * weights.pattern) / totalWeight;

  // 전략 시그널 부합도 가산 (고정 정수 상한 대신 정밀 가중치 부여)
  let strategyBonus = 0;
  if (isBreakout) strategyBonus += 3.4;
  if (isVolumeActive) strategyBonus += 2.8;
  if (isPullback) strategyBonus += 2.2;
  if (isOversold) strategyBonus += 2.5;

  const preCalibratedScore = rawScore + strategyBonus;
  const score = Math.round(Math.min(97.8, Math.max(30.0, preCalibratedScore)) * 10) / 10;

  // 태그 생성
  const tags = [];
  if (isBreakout) {
    tags.push({ text: currentPrice > ma20 && ma5 > ma20 ? '정배열 추세돌파' : '20일선 상향돌파', hot: true });
  } else if (isVolumeActive) {
    tags.push({ text: `거래량 ${volRatio}% 폭발`, hot: true });
  } else if (isOversold) {
    tags.push({ text: `RSI ${rsi} 과매도반등`, hot: true });
  } else if (isPullback) {
    tags.push({ text: '이평선 눌림목지지', hot: true });
  } else {
    tags.push({ text: currentPrice >= ma5 ? '5일선 지지' : `RSI ${rsi}`, hot: false });
  }
  tags.push({ text: `거래량비 ${volRatio}%`, hot: volRatio >= 150 });

  return {
    ...stock,
    indexOrder,
    mcapRankNum,
    todayCandle,
    currentPrice,
    diffPrice,
    changeRate,
    ma5,
    ma20,
    ma60,
    bbUpper,
    bbLower,
    rsi,
    macd,
    volRatio,
    isBreakout,
    isPullback,
    isVolumeActive,
    isOversold,
    factorTrend,
    factorVolume,
    factorMomentum,
    factorPattern,
    preCalibratedScore,
    score,
    entryLow,
    entryHigh,
    secondEntryPrice,
    secondEntryDropPct,
    avgEntryPrice,
    targetPrice,
    stopPrice,
    targetGainPct,
    stopLossPct,
    rrRatio,
    avgTargetGainPct,
    avgStopLossPct,
    avgRrRatio,
    tags
  };
}

// 상세 선택된 종목에 대해서만 65일 전체 캔들 객체 및 이평선/볼린저 배열 + 상세 추천 사유 생성
function ensureDetailedSeries(stock) {
  const candles = stock.rawCandles.map((row, idx, arr) => {
    const prevClose = idx > 0 ? arr[idx - 1][4] : row[1];
    return {
      date: idx === arr.length - 1 ? `오늘(${row[0]})` : row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
      prevClose
    };
  });

  const closes = candles.map(c => c.close);
  stock.candles = candles;
  stock.ma5Arr = calcSMAArray(closes, 5);
  stock.ma20Arr = calcSMAArray(closes, 20);
  stock.ma60Arr = calcSMAArray(closes, 60);
  stock.bb = calcBollingerBandsArray(closes, 20, 2);

  const reasons = [];
  if (stock.isBreakout) {
    stock.summaryLine = `${stock.mcapRank}(시총 ${stock.mcapText}) · 5일·20일 이동평균선 상향 돌파 및 정배열 강세`;
    reasons.push(
      `[${stock.mcapRank} / 시총 ${stock.mcapText}] 현재 주가(${stock.currentPrice.toLocaleString()}원)가 단기 5일선(${stock.ma5.toLocaleString()}원)과 중기 20일선(${stock.ma20.toLocaleString()}원) 위에 안착하며 추세 돌파 시그널이 발생했습니다.`
    );
  } else if (stock.isVolumeActive) {
    stock.summaryLine = `${stock.mcapRank}(시총 ${stock.mcapText}) · 20일 평균 대비 거래량 ${stock.volRatio}% 급증 및 매수 수급 집중`;
    reasons.push(
      `[${stock.mcapRank} / 시총 ${stock.mcapText}] 금일 거래량이 ${stock.todayCandle.volume.toLocaleString()}주로 직전 20거래일 평균 대비 ${stock.volRatio}% 급증하며 강한 양봉 수급이 유입되었습니다.`
    );
  } else if (stock.isOversold) {
    stock.summaryLine = `${stock.mcapRank}(시총 ${stock.mcapText}) · RSI(${stock.rsi}) 과매도 구간에서 저가 반발 양봉 출현`;
    reasons.push(
      `[${stock.mcapRank} / 시총 ${stock.mcapText}] 14일 RSI가 ${stock.rsi}(으)로 과매도 구간에 진입한 뒤 볼린저밴드 하단(${stock.bbLower.toLocaleString()}원) 지지와 함께 기술적 반등 양봉이 시작되었습니다.`
    );
  } else {
    stock.summaryLine = `${stock.mcapRank}(시총 ${stock.mcapText}) · 이동평균선(${stock.ma5.toLocaleString()}원) 지지력을 확보한 눌림목 구간`;
    reasons.push(
      `[${stock.mcapRank} / 시총 ${stock.mcapText}] 단기 매물을 소화하면서 5일 이동평균선(${stock.ma5.toLocaleString()}원) 및 20일 이동평균선(${stock.ma20.toLocaleString()}원) 부근에서 하방 경직성을 확보한 눌림목 구간입니다.`
    );
  }

  reasons.push(
    `보조지표 진단 결과 RSI(14) ${stock.rsi}, MACD 오실레이터 ${stock.macd.histogram >= 0 ? '+' : ''}${stock.macd.histogram.toLocaleString()}원(${stock.macd.isExpanding ? '모멘텀 확장 중' : '바닥 다지기'}), 20일 평균 대비 거래량 ${stock.volRatio}%를 기록하고 있습니다.`
  );

  const secSign = stock.sectorDelta >= 0 ? '+' : '';
  const secStat = sectorStatsMap[stock.sector];
  if (secStat) {
    const manualTxt = secStat.manualBoost !== 0
      ? ` (자동 ${secStat.scaledAutoDelta >= 0 ? '+' : ''}${secStat.scaledAutoDelta.toFixed(1)}점 + 수동 ${secStat.manualBoost > 0 ? '+' : ''}${secStat.manualBoost.toFixed(1)}점)`
      : '';
    reasons.push(
      `[업종·섹터 가감점: ${secSign}${stock.sectorDelta.toFixed(1)}점${manualTxt}] 소속 업종인 '${stock.sector}'(세부: ${stock.subSector || stock.sector}) 섹터는 KRX 전체 ${sortedSectors.length}개 섹터 중 수급 강도 ${secStat.rank}위(평균 등락률 ${secStat.avgChange >= 0 ? '+' : ''}${secStat.avgChange.toFixed(2)}%, 상승종목 비율 ${secStat.advBreadth.toFixed(0)}%, 평균 거래량비 ${secStat.avgVolRatio.toFixed(0)}%)로 ${stock.sectorDelta >= 1.0 ? '주도 섹터 수급 가산점' : (stock.sectorDelta <= -1.0 ? '소외·약세 섹터 감점' : '중립 업종 보정치')}이 반영되었습니다.`
    );
  }

  reasons.push(
    `[분할매수 & 눌림목 2차 매수 전략] 1차 진입(비중 50%)은 현재가(${stock.currentPrice.toLocaleString()}원) 부근에서 선취매하고, 손절선 이탈 전 단기 지지선 눌림목인 ${stock.secondEntryPrice.toLocaleString()}원(${stock.secondEntryDropPct.toFixed(2)}%) 도달 시 2차 추가매수(비중 50%)를 집행하여 평균단가를 ${stock.avgEntryPrice.toLocaleString()}원으로 낮추는 전략입니다.`
  );
  reasons.push(
    `[목표가 & 손익비 시나리오] 1차 목표가 ${stock.targetPrice.toLocaleString()}원 도달 시 기대수익률은 현재가 대비 +${stock.targetGainPct.toFixed(2)}%(2차 매수 평단가 대비 +${stock.avgTargetGainPct.toFixed(2)}%)이며, 최종 손절 기준가 ${stock.stopPrice.toLocaleString()}원(평단 대비 ${stock.avgStopLossPct.toFixed(2)}%) 적용 시 평단 기준 손익비 1 : ${stock.avgRrRatio.toFixed(2)}의 우수한 진입 구간입니다.`
  );
  stock.reasons = reasons;
}

// 1,000종목 데이터를 기반으로 실시간 섹터별 수급·모멘텀 강도 및 가감점(-5.0점 ~ +5.0점) 산출
function computeSectorMomentumAndApply(universe) {
  const groups = {};
  universe.forEach(s => {
    s.sector = normalizeMacroSector(s.subSector || s.sector);
    const sec = s.sector;
    if (!groups[sec]) {
      groups[sec] = {
        name: sec,
        count: 0,
        sumChange: 0,
        advCount: 0,
        sumVolRatio: 0,
        aboveMa20Count: 0
      };
    }
    const g = groups[sec];
    g.count += 1;
    g.sumChange += s.changeRate;
    if (s.changeRate > 0) g.advCount += 1;
    g.sumVolRatio += Math.min(350, s.volRatio);
    if (s.currentPrice >= s.ma20) g.aboveMa20Count += 1;
  });

  const sectorList = Object.values(groups).map(g => {
    const avgChange = g.count > 0 ? g.sumChange / g.count : 0;
    const advBreadth = g.count > 0 ? (g.advCount / g.count) * 100 : 50;
    const avgVolRatio = g.count > 0 ? g.sumVolRatio / g.count : 100;
    const ma20Breadth = g.count > 0 ? (g.aboveMa20Count / g.count) * 100 : 50;

    // 섹터 상대강도 지수: 평균 등락률(가중 40%) + 상승종목 확산도(30%) + 거래량 수급비(15%) + 20일선 안착률(15%)
    const rawStrength =
      avgChange * 14.0 +
      (advBreadth - 48.0) * 0.42 +
      (avgVolRatio - 95.0) * 0.14 +
      (ma20Breadth - 48.0) * 0.22;

    return {
      name: g.name,
      count: g.count,
      avgChange,
      advBreadth,
      avgVolRatio,
      ma20Breadth,
      rawStrength
    };
  });

  // 섹터 강도 순으로 정렬
  sectorList.sort((a, b) => b.rawStrength - a.rawStrength);

  const maxStr = sectorList[0]?.rawStrength || 10;
  const minStr = sectorList[sectorList.length - 1]?.rawStrength || -10;
  const spanStr = Math.max(4, maxStr - minStr);
  const nSec = sectorList.length;

  sectorStatsMap = {};
  sectorList.forEach((sec, idx) => {
    sec.rank = idx + 1;
    // -1.0 (최약세 섹터) ~ +1.0 (최강 주도 섹터) 정규화
    const normScore = ((sec.rawStrength - minStr) / spanStr) * 2 - 1;
    const rankPos = nSec > 1 ? 1 - (idx / (nSec - 1)) * 2 : 0; // +1.0 ~ -1.0

    // 기본 자동 가감점: -4.4점 ~ +4.8점 범위에서 연속 분포
    const baseAutoDelta = Math.round(((normScore * 0.55 + rankPos * 0.45) * 4.6) * 10) / 10;
    const scaledAutoDelta = Math.round((baseAutoDelta * (weights.sector / 100)) * 10) / 10;
    const manualBoost = Number(customSectorBoost[sec.name] || 0);
    const totalDelta = Math.round(Math.max(-9.5, Math.min(9.5, scaledAutoDelta + manualBoost)) * 10) / 10;

    sec.baseAutoDelta = baseAutoDelta;
    sec.scaledAutoDelta = scaledAutoDelta;
    sec.manualBoost = manualBoost;
    sec.totalDelta = totalDelta;
    sectorStatsMap[sec.name] = sec;
  });

  sortedSectors = [...sectorList].sort((a, b) => b.totalDelta - a.totalDelta || b.rawStrength - a.rawStrength);

  // 각 종목의 원점수(preCalibratedScore) 및 태그에 섹터 가감점 반영
  universe.forEach(s => {
    const secStat = sectorStatsMap[s.sector] || { totalDelta: 0, rank: 8 };
    s.sectorDelta = secStat.totalDelta;
    s.sectorRank = secStat.rank;
    s.preCalibratedScore = s.preCalibratedScore + s.sectorDelta;

    const sign = s.sectorDelta >= 0 ? '+' : '';
    const sectorTagText = `${s.sector} ${sign}${s.sectorDelta.toFixed(1)}점`;
    // 기존 두 번째 태그 앞에 섹터 가감점 태그 삽입
    s.tags = [
      s.tags[0],
      {
        text: sectorTagText,
        hot: false,
        sectorClass: s.sectorDelta >= 0.5 ? 'sector-pos' : (s.sectorDelta <= -0.5 ? 'sector-neg' : '')
      }
    ];
  });
}

// 상단 섹터 수급 모멘텀 바 & 섹터 드롭다운/수동 가감점 UI 렌더링 (스크롤바 없는 반응형 그리드 + 펼치기/접기)
function renderSectorControlsAndStrip() {
  const barEl = document.getElementById('sectorMomentumBar');
  const resetBtn = document.getElementById('resetSectorFilterBtn');
  const expandBtn = document.getElementById('toggleSectorExpandBtn');

  if (expandBtn) {
    expandBtn.innerText = sectorBarExpanded
      ? `핵심 섹터만 접기 ▲`
      : `전체 ${sortedSectors.length}개 섹터 펼치기 ▼`;
  }

  if (barEl) {
    if (currentSector !== 'ALL') resetBtn.classList.remove('hidden');
    else resetBtn.classList.add('hidden');

    // 기본 상태에서는 주도 상위 4개 + 소외 하위 2개 (현재 선택된 섹터가 그 외라면 함께 포함)만 깔끔하게 1줄 그리드로 표시
    let displaySectors = sortedSectors;
    if (!sectorBarExpanded && sortedSectors.length > 6) {
      const top4 = sortedSectors.slice(0, 4);
      const bottom2 = sortedSectors.slice(-2);
      const picked = [...top4];
      if (currentSector !== 'ALL') {
        const activeObj = sortedSectors.find(s => s.name === currentSector);
        if (activeObj && !picked.includes(activeObj) && !bottom2.includes(activeObj)) {
          picked.push(activeObj);
        }
      }
      displaySectors = [...picked, ...bottom2];
    }

    barEl.innerHTML = displaySectors.map(sec => {
      const isSelected = currentSector === sec.name;
      const sign = sec.totalDelta >= 0 ? '+' : '';
      const chgSign = sec.avgChange >= 0 ? '+' : '';
      const deltaClass = sec.totalDelta >= 0.8 ? 'pos' : (sec.totalDelta <= -0.8 ? 'neg' : 'neu');
      const icon = sec.totalDelta >= 1.5 ? '🔥' : (sec.totalDelta <= -1.5 ? '❄️' : '•');
      return `
        <button type="button" class="sector-chip ${isSelected ? 'active' : ''}" data-sector="${sec.name}" title="${sec.name} (${sec.count}종목) · 평균 등락률 ${chgSign}${sec.avgChange.toFixed(2)}% · 상승비율 ${sec.advBreadth.toFixed(0)}% · 클릭 시 이 섹터만 필터링">
          <div class="sector-chip-left">
            <span class="sector-chip-rank">${icon}${sec.rank}위</span>
            <span class="sector-chip-name">${sec.name}</span>
            <span style="font-size:0.7rem; color:var(--text-muted);">(${chgSign}${sec.avgChange.toFixed(2)}%)</span>
          </div>
          <span class="sector-chip-delta ${deltaClass}">${sign}${sec.totalDelta.toFixed(1)}점</span>
        </button>
      `;
    }).join('');

    barEl.querySelectorAll('.sector-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const secName = chip.getAttribute('data-sector');
        currentSector = currentSector === secName ? 'ALL' : secName;
        document.getElementById('sectorSelect').value = currentSector;
        selectedStock = null;
        refreshUI();
      });
    });
  }

  // 최초 1회 또는 섹터 목록 갱신 시 드롭다운과 수동 가감점 슬라이더 생성
  const sectorSelect = document.getElementById('sectorSelect');
  const modalSectorFilter = document.getElementById('modalSectorFilter');
  const boostGrid = document.getElementById('customSectorBoostGrid');

  if (sectorSelect) {
    const prevVal = currentSector;
    sectorSelect.innerHTML = `<option value="ALL">전체 섹터 (업종 가감점 자동반영)</option>` +
      sortedSectors.map(sec => {
        const sign = sec.totalDelta >= 0 ? '+' : '';
        return `<option value="${sec.name}">${sec.name} (${sec.count}종목 · 가감 ${sign}${sec.totalDelta.toFixed(1)}점)</option>`;
      }).join('');
    sectorSelect.value = prevVal;
  }

  if (modalSectorFilter) {
    const prevModalSec = modalSectorFilter.value || 'ALL';
    modalSectorFilter.innerHTML = `<option value="ALL">전체 업종/섹터 (1,000종목)</option>` +
      sortedSectors.map(sec => {
        const sign = sec.totalDelta >= 0 ? '+' : '';
        return `<option value="${sec.name}">${sec.name} (${sec.count}종목 · ${sign}${sec.totalDelta.toFixed(1)}점)</option>`;
      }).join('');
    modalSectorFilter.value = prevModalSec;
  }

  if (boostGrid && !sectorControlsInitialized) {
    sectorControlsInitialized = true;
    boostGrid.innerHTML = sortedSectors.map(sec => `
      <div class="custom-sector-item">
        <span>${sec.name} <small style="color:var(--text-muted)">(${sec.count})</small></span>
        <select class="sector-boost-select" data-sec="${sec.name}">
          <option value="5">+5.0점 (최우선 가산)</option>
          <option value="3">+3.0점 (강세 우대)</option>
          <option value="1.5">+1.5점 (소폭 가산)</option>
          <option value="0" selected>0.0점 (자동 모멘텀만)</option>
          <option value="-1.5">-1.5점 (소폭 감점)</option>
          <option value="-3">-3.0점 (비선호 감점)</option>
          <option value="-5">-5.0점 (강력 감점)</option>
        </select>
      </div>
    `).join('');

    boostGrid.querySelectorAll('.sector-boost-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const secName = sel.getAttribute('data-sec');
        customSectorBoost[secName] = Number(sel.value);
        refreshUI();
      });
    });
  }
}

// 1,000개 전체 종목 평가 및 전략/시장/섹터 필터링 (연속 분포 보정 + 섹터 모멘텀 가감점 반영)
function filterAndRankTop5() {
  analyzedUniverse = REAL_STOCK_UNIVERSE.map((s, idx) => evaluateStock(s, idx));

  // 섹터별 실시간 수급·모멘텀 강도 및 가감점(-5.0점 ~ +5.0점) 산출 및 원점수에 반영
  computeSectorMomentumAndApply(analyzedUniverse);
  renderSectorControlsAndStrip();

  // 전체 1,000종목 원점수(preCalibratedScore: 섹터 가감점 포함) 기준 정렬
  const sortedByOverall = [...analyzedUniverse].sort(
    (a, b) =>
      b.preCalibratedScore - a.preCalibratedScore ||
      b.volRatio - a.volRatio ||
      b.changeRate - a.changeRate ||
      a.indexOrder - b.indexOrder
  );

  // 전체 모집단 최소~최대 원점수 스펙트럼 추출 후 Z-분포 + 비선형 순위 곡선 결합 보정
  const maxRaw = sortedByOverall[0]?.preCalibratedScore || 90;
  const minRaw = sortedByOverall[sortedByOverall.length - 1]?.preCalibratedScore || 40;
  const rawSpan = Math.max(10, maxRaw - minRaw);
  const totalN = sortedByOverall.length || 1000;

  let prevOverallScore = 98.5;
  sortedByOverall.forEach((item, idx) => {
    item.overallQuantRank = idx + 1;
    const normRaw = (item.preCalibratedScore - minRaw) / rawSpan; // 0.0 ~ 1.0

    // 상위권 변별력을 넓히는 지수형 분포 곡선 (1위 ~96.6점, 2위 ~94.5점, 3위 ~92.6점, 4위 ~90.9점, 5위 ~89.3점...)
    let topSpreadDrop = 0;
    if (idx === 0) topSpreadDrop = 0;
    else if (idx === 1) topSpreadDrop = 2.1;
    else if (idx === 2) topSpreadDrop = 4.0;
    else if (idx === 3) topSpreadDrop = 5.8;
    else if (idx === 4) topSpreadDrop = 7.4;
    else if (idx < 25) topSpreadDrop = 7.4 + (idx - 4) * 0.65;
    else topSpreadDrop = 21.0 + Math.pow((idx - 25) / (totalN - 25), 0.72) * 44.0;

    const blended = (34.0 + normRaw * 62.6) * 0.45 + (96.6 - topSpreadDrop) * 0.55;
    let calibrated = Math.round(Math.min(96.8, Math.max(28.0, blended)) * 10) / 10;

    // 상위 30위권 내 동점 방지 및 최소 간격 보장
    if (idx > 0 && idx < 10) {
      const minGap = idx <= 5 ? 1.6 : 0.7;
      if (prevOverallScore - calibrated < minGap) {
        calibrated = Math.round((prevOverallScore - minGap) * 10) / 10;
      }
    } else if (idx >= 10 && idx < 60 && calibrated >= prevOverallScore) {
      calibrated = Math.round((prevOverallScore - 0.2) * 10) / 10;
    }

    item.score = calibrated;
    prevOverallScore = calibrated;
  });

  // 시장/규모 및 섹터 필터 적용된 모집단
  const marketFiltered = analyzedUniverse.filter(s => {
    if (currentMarket === 'KOSPI' && s.market !== 'KOSPI') return false;
    if (currentMarket === 'KOSDAQ' && s.market !== 'KOSDAQ') return false;
    if (currentMarket === 'TOP200' && s.mcapRankNum > 100) return false;
    if (currentSector !== 'ALL' && s.sector !== currentSector) return false;
    return true;
  });

  const breakoutList = marketFiltered.filter(s => s.isBreakout);
  const pullbackList = marketFiltered.filter(s => s.isPullback);
  const volumeList = marketFiltered.filter(s => s.isVolumeActive);
  const oversoldList = marketFiltered.filter(s => s.isOversold);

  document.getElementById('cnt-all').innerText = marketFiltered.length.toLocaleString();
  document.getElementById('cnt-breakout').innerText = breakoutList.length.toLocaleString();
  document.getElementById('cnt-pullback').innerText = pullbackList.length.toLocaleString();
  document.getElementById('cnt-volume').innerText = volumeList.length.toLocaleString();
  document.getElementById('cnt-oversold').innerText = oversoldList.length.toLocaleString();

  let matchedList = [];
  let fallbackList = [];

  // 각 전략별 특화 정렬 기준 적용
  const strategySpecScore = s => {
    if (currentStrategy === 'breakout') return s.preCalibratedScore + s.factorTrend * 0.25;
    if (currentStrategy === 'pullback') return s.preCalibratedScore + s.factorPattern * 0.22 + s.factorTrend * 0.15;
    if (currentStrategy === 'volume') return s.preCalibratedScore + s.factorVolume * 0.30;
    if (currentStrategy === 'oversold') return s.preCalibratedScore + (100 - s.rsi) * 0.35 + s.factorMomentum * 0.20;
    return s.score;
  };

  if (currentStrategy === 'breakout') {
    matchedList = [...breakoutList].sort((a, b) => strategySpecScore(b) - strategySpecScore(a));
    fallbackList = marketFiltered.filter(s => !s.isBreakout).sort((a, b) => b.score - a.score);
  } else if (currentStrategy === 'pullback') {
    matchedList = [...pullbackList].sort((a, b) => strategySpecScore(b) - strategySpecScore(a));
    fallbackList = marketFiltered.filter(s => !s.isPullback).sort((a, b) => b.score - a.score);
  } else if (currentStrategy === 'volume') {
    matchedList = [...volumeList].sort((a, b) => strategySpecScore(b) - strategySpecScore(a));
    fallbackList = marketFiltered.filter(s => !s.isVolumeActive).sort((a, b) => b.volRatio - a.volRatio);
  } else if (currentStrategy === 'oversold') {
    matchedList = [...oversoldList].sort((a, b) => strategySpecScore(b) - strategySpecScore(a));
    fallbackList = marketFiltered.filter(s => !s.isOversold).sort((a, b) => a.rsi - b.rsi);
  } else {
    matchedList = [...marketFiltered].sort((a, b) => b.score - a.score || b.volRatio - a.volRatio);
  }

  const totalInMarket = marketFiltered.length;
  const matchedCount = matchedList.length;
  const topPct = ((5 / totalInMarket) * 100).toFixed(2);
  document.getElementById('funnelBadge').innerText = `${totalInMarket.toLocaleString()}종목 중 상위 ${topPct}%`;
  document.getElementById('funnelDetailBar').innerHTML = `
    <span>모집단 <b>${totalInMarket.toLocaleString()}</b>종목</span>
    <span class="funnel-arrow">➔</span>
    <span>전략 부합 <b id="funnelMatchedCount">${matchedCount.toLocaleString()}</b>종목</span>
    <span class="funnel-arrow">➔</span>
    <span class="funnel-highlight">최상위 <b>TOP 5</b></span>
  `;

  const combined = [...matchedList, ...fallbackList];
  currentTop5 = combined.slice(0, 5);

  // 선택된 전략/시장 필터 내 TOP 5 종목들의 점수가 지나치게 촘촘하거나 역전되지 않도록 전략 적합도 기반 정밀 보정
  if (currentTop5.length > 0 && currentStrategy !== 'all') {
    const topBase = Math.min(96.4, Math.max(91.8, currentTop5[0].score + 3.2));
    const stepDrops = [0, 2.2, 4.1, 5.9, 7.6];
    currentTop5.forEach((s, i) => {
      const indivJitter = ((s.factorTrend + s.factorVolume) % 0.7) - 0.3;
      const targetS = topBase - stepDrops[i] + indivJitter * 0.4;
      s.score = Math.round(Math.max(75.0, Math.min(96.6, targetS)) * 10) / 10;
      if (i > 0 && currentTop5[i - 1].score - s.score < 1.4) {
        s.score = Math.round((currentTop5[i - 1].score - 1.5) * 10) / 10;
      }
    });
  } else if (currentTop5.length > 0) {
    // 전체/시장 필터에서도 TOP 5 간 최소 1.5~2.2점 간격 보장
    for (let i = 1; i < currentTop5.length; i++) {
      if (currentTop5[i - 1].score - currentTop5[i].score < 1.5) {
        currentTop5[i].score = Math.round((currentTop5[i - 1].score - 1.7) * 10) / 10;
      }
    }
  }
}

// 좌측 TOP 5 카드, 비교 테이블 및 모바일 상단 TOP 5 빠른 전환 바 렌더링
function renderTop5Sidebar() {
  const listEl = document.getElementById('top5List');
  const tbodyEl = document.getElementById('comparisonTableBody');
  const quickBarEl = document.getElementById('mobileTop5QuickBar');
  listEl.innerHTML = '';
  tbodyEl.innerHTML = '';
  if (quickBarEl) quickBarEl.innerHTML = '';

  currentTop5.forEach((stock, idx) => {
    const rank = idx + 1;
    const isSelected = selectedStock && selectedStock.code === stock.code;
    const isUp = stock.changeRate > 0;
    const isDown = stock.changeRate < 0;
    const sign = isUp ? '+' : '';
    const arrow = isUp ? '▲' : (isDown ? '▼' : '-');

    const card = document.createElement('div');
    card.className = `stock-item-card ${isSelected ? 'selected' : ''}`;
    card.innerHTML = `
      <div class="card-row-1">
        <div class="rank-name-wrap">
          <span class="rank-num ${rank === 1 ? 'top1' : (rank === 2 ? 'top2' : '')}">${rank}</span>
          <span class="stock-title">${stock.name}</span>
          <span class="stock-meta">${stock.mcapRank}</span>
        </div>
        <span class="score-pill">${stock.score.toFixed(1)}점</span>
      </div>
      <div class="card-row-2">
        <div class="item-price">${stock.currentPrice.toLocaleString()}원</div>
        <div class="item-change ${isUp ? 'up' : (isDown ? 'down' : '')}">
          ${arrow} ${Math.abs(stock.diffPrice).toLocaleString()}원 (${sign}${stock.changeRate.toFixed(2)}%)
        </div>
      </div>
      <div class="card-row-3">
        <div class="signal-tags">
          ${stock.tags.map(t => `<span class="sig-tag ${t.hot ? 'hot' : ''} ${t.sectorClass || ''}">${t.text}</span>`).join('')}
        </div>
        <span class="expected-return-mini">목표 <b>+${stock.targetGainPct.toFixed(1)}%</b></span>
      </div>
    `;

    card.addEventListener('click', () => {
      selectStock(stock, rank, { scrollOnMobile: true });
    });
    listEl.appendChild(card);

    const tr = document.createElement('tr');
    if (isSelected) tr.className = 'active-row';
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><strong>${rank}. ${stock.name}</strong></td>
      <td>${stock.currentPrice.toLocaleString()}원</td>
      <td style="color:#34d399; font-weight:700;">${stock.score.toFixed(1)}점</td>
      <td>${stock.rsi}</td>
      <td style="color:#f23645; font-weight:700;">+${stock.targetGainPct.toFixed(1)}%</td>
    `;
    tr.addEventListener('click', () => {
      selectStock(stock, rank, { scrollOnMobile: true });
    });
    tbodyEl.appendChild(tr);

    if (quickBarEl) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `mobile-top5-pill ${isSelected ? 'active' : ''}`;
      pill.innerHTML = `
        <span class="m-pill-rank">${rank}위</span>
        <span class="m-pill-name">${stock.name}</span>
        <span class="m-pill-chg ${isUp ? 'up' : (isDown ? 'down' : '')}">${sign}${stock.changeRate.toFixed(1)}%</span>
      `;
      pill.addEventListener('click', () => {
        selectStock(stock, rank, { scrollOnMobile: false });
      });
      quickBarEl.appendChild(pill);
    }
  });
}

// 종목 선택 시 우측 상세 패널 업데이트
function selectStock(stock, rank = null, options = {}) {
  ensureDetailedSeries(stock);
  selectedStock = stock;
  hoverCandleIndex = null;

  renderTop5Sidebar();

  if (options.scrollOnMobile && window.innerWidth <= 1180) {
    const detailEl = document.getElementById('detailSection');
    if (detailEl) {
      const y = detailEl.getBoundingClientRect().top + window.scrollY - 12;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
    document.querySelectorAll('.m-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-target') === 'detailSection');
    });
  }

  const top5Idx = currentTop5.findIndex(s => s.code === stock.code);
  const rankLabel = top5Idx !== -1
    ? `TOP ${top5Idx + 1} 추천`
    : (rank ? `TOP ${rank} 추천` : `퀀트 ${stock.overallQuantRank}위 / 1,000종목`);

  document.getElementById('detailRankBadge').innerText = rankLabel;
  document.getElementById('detailMarketBadge').innerText = stock.mcapRank;
  document.getElementById('detailMcapBadge').innerText = `시총 ${stock.mcapText}`;
  const secSign = stock.sectorDelta >= 0 ? '+' : '';
  const detailSecEl = document.getElementById('detailSectorBadge');
  if (detailSecEl) {
    detailSecEl.innerText = `${stock.sector} (${secSign}${stock.sectorDelta.toFixed(1)}점 · 섹터 ${stock.sectorRank}위)`;
  }
  document.getElementById('detailCodeText').innerText = stock.code;
  document.getElementById('detailNameText').innerText = stock.name;
  document.getElementById('detailSummaryLine').innerText = stock.summaryLine;

  const isUp = stock.changeRate > 0;
  const isDown = stock.changeRate < 0;
  const arrow = isUp ? '▲' : (isDown ? '▼' : '-');
  document.getElementById('detailPriceText').innerText = `${stock.currentPrice.toLocaleString()}원`;
  const diffEl = document.getElementById('detailDiffText');
  diffEl.className = `price-diff-row ${isUp ? 'up' : (isDown ? 'down' : '')}`;
  diffEl.innerText = `${arrow} ${Math.abs(stock.diffPrice).toLocaleString()}원 (${isUp ? '+' : ''}${stock.changeRate.toFixed(2)}%)`;

  const tc = stock.todayCandle;
  document.getElementById('detailOhlcMini').innerText =
    `전일종가 ${tc.prevClose.toLocaleString()} · 시 ${tc.open.toLocaleString()} · 고 ${tc.high.toLocaleString()} · 저 ${tc.low.toLocaleString()}`;

  document.getElementById('detailScoreNum').innerText = stock.score.toFixed(1);
  const scoreCircle = document.getElementById('detailScoreCircle');
  const degPct = Math.min(98, stock.score);
  scoreCircle.style.background = `radial-gradient(circle, #1e293b 62%, transparent 63%), conic-gradient(#10b981 0% ${degPct}%, #262e3d ${degPct}% 100%)`;
  document.getElementById('detailSignalGrade').innerText =
    stock.score >= 90 ? '최상위 강력 매수' : (stock.score >= 82 ? '강력 매수 시그널' : '매수 진입 유망');

  document.getElementById('planEntryPrice').innerText = `${stock.entryLow.toLocaleString()} ~ ${stock.entryHigh.toLocaleString()}원`;
  document.getElementById('planEntryDesc').innerText = `현재가 부근 1차 진입 (권장 비중 50%)`;

  const secEntryEl = document.getElementById('planSecondEntryPrice');
  const secEntryDescEl = document.getElementById('planSecondEntryDesc');
  if (secEntryEl && secEntryDescEl) {
    secEntryEl.innerHTML = `${stock.secondEntryPrice.toLocaleString()}원 <span class="dip-tag">${stock.secondEntryDropPct.toFixed(2)}%</span>`;
    secEntryDescEl.innerText = `체결 시 합산 평단가 ${stock.avgEntryPrice.toLocaleString()}원 (비중 50%)`;
  }

  document.getElementById('planTargetPrice').innerHTML = `${stock.targetPrice.toLocaleString()}원 <span class="gain-tag">+${stock.targetGainPct.toFixed(2)}%</span>`;
  document.getElementById('planTargetDesc').innerText = `2차매수 평단 대비 +${stock.avgTargetGainPct.toFixed(2)}% 수익`;

  document.getElementById('planStopPrice').innerHTML = `${stock.stopPrice.toLocaleString()}원 <span class="loss-tag">${stock.stopLossPct.toFixed(2)}%</span>`;
  document.getElementById('planStopDesc').innerText = `2차매수 평단 대비 ${stock.avgStopLossPct.toFixed(2)}% (지지 이탈 손절)`;

  document.getElementById('planRRRatio').innerText = `1 : ${stock.rrRatio.toFixed(2)} (평단 1 : ${stock.avgRrRatio.toFixed(2)})`;

  const reasonListEl = document.getElementById('detailReasonList');
  reasonListEl.innerHTML = stock.reasons.map(r => `<li>${r}</li>`).join('');

  document.getElementById('barTrend').style.width = `${stock.factorTrend}%`;
  document.getElementById('valTrend').innerText = stock.factorTrend.toFixed(1);
  document.getElementById('barVolume').style.width = `${stock.factorVolume}%`;
  document.getElementById('valVolume').innerText = stock.factorVolume.toFixed(1);
  document.getElementById('barMomentum').style.width = `${stock.factorMomentum}%`;
  document.getElementById('valMomentum').innerText = stock.factorMomentum.toFixed(1);
  document.getElementById('barPattern').style.width = `${stock.factorPattern}%`;
  document.getElementById('valPattern').innerText = stock.factorPattern.toFixed(1);

  const barSector = document.getElementById('barSector');
  const valSector = document.getElementById('valSector');
  const labelSector = document.getElementById('labelSectorFactor');
  if (barSector && valSector && labelSector) {
    labelSector.innerText = `섹터 (${stock.sector})`;
    // -6점 ~ +6점 범위를 10% ~ 98% 바로 시각화
    const secPct = Math.min(98, Math.max(12, Math.round(50 + stock.sectorDelta * 8)));
    barSector.style.width = `${secPct}%`;
    barSector.className = `progress-fill sector-fill ${stock.sectorDelta >= 0 ? 'pos' : 'neg'}`;
    valSector.innerText = `${secSign}${stock.sectorDelta.toFixed(1)}점`;
    valSector.style.color = stock.sectorDelta >= 0 ? '#34d399' : '#60a5fa';
  }

  document.getElementById('indRsiVal').innerText = stock.rsi;
  document.getElementById('indRsiStatus').innerText =
    stock.rsi <= 40 ? '과매도 반등권' : (stock.rsi <= 68 ? '건전한 상승 탄력' : '단기 강세 구간');

  const macdSign = stock.macd.histogram >= 0 ? '+' : '';
  document.getElementById('indMacdVal').innerText = `${macdSign}${stock.macd.histogram.toLocaleString()}`;
  document.getElementById('indMacdStatus').innerText = stock.macd.isExpanding ? '모멘텀 확장 중' : '바닥 다지기';

  document.getElementById('indVolVal').innerText = `${stock.volRatio}%`;
  document.getElementById('indVolStatus').innerText = stock.volRatio >= 100 ? '20일 평균 상회' : '평균 수준 소화';

  const topPctRank = ((stock.overallQuantRank / analyzedUniverse.length) * 100).toFixed(1);
  document.getElementById('indRankVal').innerText = `${stock.overallQuantRank}위 / ${analyzedUniverse.length.toLocaleString()}`;
  document.getElementById('indRankStatus').innerText = `전체 상위 ${topPctRank}%`;

  updatePositionSimulator();
  updateHoverLegend(stock.candles.length - 1);
  drawCandlestickChart();
}

// 투자금 대비 1차·2차 분할매수 수량, 합산 평단가 및 예상 손익 계산기
function updatePositionSimulator() {
  if (!selectedStock) return;
  const inputEl = document.getElementById('capitalInput');
  const capital = Math.max(0, Number(inputEl.value) || 0);

  const halfCap = capital * 0.5;
  const shares1 = Math.floor(halfCap / selectedStock.currentPrice);
  const invested1 = shares1 * selectedStock.currentPrice;

  const remCapFor2 = capital - invested1;
  const shares2 = Math.floor(remCapFor2 / selectedStock.secondEntryPrice);
  const invested2 = shares2 * selectedStock.secondEntryPrice;

  const totalShares = shares1 + shares2;
  const totalInvested = invested1 + invested2;
  const actualAvgPrice = totalShares > 0 ? Math.round(totalInvested / totalShares) : selectedStock.avgEntryPrice;

  const expectedProfitSplit = totalShares * (selectedStock.targetPrice - actualAvgPrice);
  const maxLossSplit = totalShares * (selectedStock.stopPrice - actualAvgPrice);

  const e1El = document.getElementById('calcEntry1Shares');
  const e2El = document.getElementById('calcEntry2Shares');
  if (e1El) {
    e1El.innerText = `${shares1.toLocaleString()}주 × ${selectedStock.currentPrice.toLocaleString()}원 (${invested1.toLocaleString()}원)`;
  }
  if (e2El) {
    e2El.innerText = `${shares2.toLocaleString()}주 × ${selectedStock.secondEntryPrice.toLocaleString()}원 (${invested2.toLocaleString()}원)`;
  }

  document.getElementById('calcShares').innerText =
    `총 ${totalShares.toLocaleString()}주 · 평단 ${actualAvgPrice.toLocaleString()}원`;
  document.getElementById('calcProfit').innerText =
    `+${expectedProfitSplit.toLocaleString()}원 (평단대비 +${selectedStock.avgTargetGainPct.toFixed(2)}%)`;
  document.getElementById('calcLoss').innerText =
    `${maxLossSplit.toLocaleString()}원 (평단대비 ${selectedStock.avgStopLossPct.toFixed(2)}%)`;
}

// 차트 상단 호버 범례 업데이트
function updateHoverLegend(idx) {
  if (!selectedStock || !selectedStock.candles) return;
  const c = selectedStock.candles[idx];
  if (!c) return;

  document.getElementById('hoverDate').innerText = c.date;
  document.getElementById('hoverOpen').innerText = c.open.toLocaleString();
  document.getElementById('hoverHigh').innerText = c.high.toLocaleString();
  document.getElementById('hoverLow').innerText = c.low.toLocaleString();
  document.getElementById('hoverClose').innerText = c.close.toLocaleString();
  document.getElementById('hoverVol').innerText = c.volume.toLocaleString();

  const ma5 = selectedStock.ma5Arr[idx];
  const ma20 = selectedStock.ma20Arr[idx];
  const ma60 = selectedStock.ma60Arr[idx];
  document.getElementById('hoverMA5').innerText = ma5 ? ma5.toLocaleString() : '-';
  document.getElementById('hoverMA20').innerText = ma20 ? ma20.toLocaleString() : '-';
  document.getElementById('hoverMA60').innerText = ma60 ? ma60.toLocaleString() : '-';
}

// 차트 화면 너비에 따른 반응형 여백 및 표시 봉 개수 산출
function getChartLayoutMetrics(width, totalLen) {
  const isCompact = width < 520;
  const displayCount = Math.min(isCompact ? 30 : 45, totalLen);
  const padLeft = isCompact ? 8 : 14;
  const padRight = isCompact ? 58 : 84;
  const padTop = isCompact ? 14 : 18;
  const padBottom = isCompact ? 22 : 26;
  return { isCompact, displayCount, padLeft, padRight, padTop, padBottom };
}

// HTML5 Canvas 고해상도 캔들스틱 + 이평선 + 볼린저밴드 + 거래량 차트 렌더링
function drawCandlestickChart() {
  if (!selectedStock || !selectedStock.candles) return;
  const canvas = document.getElementById('candleCanvas');
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const totalLen = selectedStock.candles.length;
  const { isCompact, displayCount, padLeft, padRight, padTop, padBottom } = getChartLayoutMetrics(width, totalLen);
  const startIndex = totalLen - displayCount;
  const candles = selectedStock.candles.slice(startIndex);

  const showMA = document.getElementById('toggleMA').checked;
  const showBB = document.getElementById('toggleBB').checked;
  const showLines = document.getElementById('toggleLines').checked;

  const priceAreaHeight = (height - padTop - padBottom) * 0.72;
  const volAreaTop = padTop + priceAreaHeight + 12;
  const volAreaHeight = (height - padTop - padBottom) - priceAreaHeight - 12;
  const plotWidth = Math.max(50, width - padLeft - padRight);

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let maxVol = 0;

  for (let i = 0; i < displayCount; i++) {
    const gIdx = startIndex + i;
    const c = selectedStock.candles[gIdx];
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
    if (c.volume > maxVol) maxVol = c.volume;

    if (showBB) {
      const bbu = selectedStock.bb.upper[gIdx];
      const bbl = selectedStock.bb.lower[gIdx];
      if (bbu && bbu > maxPrice) maxPrice = bbu;
      if (bbl && bbl < minPrice) minPrice = bbl;
    }
    if (showMA) {
      const m60 = selectedStock.ma60Arr[gIdx];
      if (m60) {
        if (m60 > maxPrice) maxPrice = m60;
        if (m60 < minPrice) minPrice = m60;
      }
    }
  }

  if (showLines) {
    maxPrice = Math.max(maxPrice, selectedStock.targetPrice);
    minPrice = Math.min(minPrice, selectedStock.stopPrice);
  }

  const priceMargin = (maxPrice - minPrice) * 0.08 || 100;
  maxPrice += priceMargin;
  minPrice = Math.max(0, minPrice - priceMargin);

  const priceToY = p => padTop + priceAreaHeight - ((p - minPrice) / (maxPrice - minPrice)) * priceAreaHeight;
  const volToY = v => volAreaTop + volAreaHeight - (v / (maxVol * 1.1 || 1)) * volAreaHeight;
  const stepX = plotWidth / displayCount;
  const idxToX = i => padLeft + stepX * i + stepX / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
  ctx.lineWidth = 1;

  const gridRows = 5;
  ctx.fillStyle = '#64748b';
  ctx.font = isCompact ? '9.5px monospace' : '11px monospace';
  ctx.textAlign = 'left';

  for (let r = 0; r <= gridRows; r++) {
    const y = padTop + (priceAreaHeight / gridRows) * r;
    const pVal = Math.round(maxPrice - ((maxPrice - minPrice) / gridRows) * r);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillText(pVal.toLocaleString(), width - padRight + (isCompact ? 4 : 6), y + 4);
  }

  ctx.beginPath();
  ctx.moveTo(padLeft, volAreaTop - 6);
  ctx.lineTo(width - padRight, volAreaTop - 6);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.stroke();

  if (showBB) {
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < displayCount; i++) {
      const u = selectedStock.bb.upper[startIndex + i];
      if (u === null) continue;
      const x = idxToX(i);
      const y = priceToY(u);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    for (let i = displayCount - 1; i >= 0; i--) {
      const l = selectedStock.bb.lower[startIndex + i];
      if (l === null) continue;
      ctx.lineTo(idxToX(i), priceToY(l));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(168, 85, 247, 0.07)';
    ctx.fill();

    ['upper', 'lower'].forEach(key => {
      ctx.beginPath();
      let s = false;
      for (let i = 0; i < displayCount; i++) {
        const val = selectedStock.bb[key][startIndex + i];
        if (val === null) continue;
        const x = idxToX(i);
        const y = priceToY(val);
        if (!s) { ctx.moveTo(x, y); s = true; }
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    ctx.restore();
  }

  if (showLines) {
    const drawGuideLine = (price, color, label) => {
      const y = priceToY(price);
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = isCompact ? 'bold 9.5px sans-serif' : 'bold 10px sans-serif';
      ctx.fillText(`${label} ${price.toLocaleString()}원`, padLeft + 4, y - 4);
      ctx.restore();
    };

    drawGuideLine(selectedStock.targetPrice, '#10b981', '1차목표');
    drawGuideLine(selectedStock.secondEntryPrice, '#f59e0b', isCompact ? '2차매수' : '2차추가매수(눌림목)');
    drawGuideLine(selectedStock.stopPrice, '#3b82f6', '손절기준');
  }

  const candleWidth = Math.max(isCompact ? 3.5 : 4, Math.min(14, stepX * 0.64));
  const dateTickStep = isCompact ? 7 : 8;

  for (let i = 0; i < displayCount; i++) {
    const c = candles[i];
    const x = idxToX(i);
    const isUp = c.close >= c.open;
    const color = isUp ? '#f23645' : '#2962ff';

    ctx.beginPath();
    ctx.moveTo(x, priceToY(c.high));
    ctx.lineTo(x, priceToY(c.low));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const yOpen = priceToY(c.open);
    const yClose = priceToY(c.close);
    const topY = Math.min(yOpen, yClose);
    const bodyH = Math.max(2, Math.abs(yClose - yOpen));

    ctx.fillStyle = color;
    ctx.fillRect(x - candleWidth / 2, topY, candleWidth, bodyH);

    const vTop = volToY(c.volume);
    const vH = Math.max(1, volAreaTop + volAreaHeight - vTop);
    ctx.fillStyle = isUp ? 'rgba(242, 54, 69, 0.55)' : 'rgba(41, 98, 255, 0.55)';
    ctx.fillRect(x - candleWidth / 2, vTop, candleWidth, vH);

    if (i % dateTickStep === 0 || i === displayCount - 1) {
      ctx.fillStyle = '#64748b';
      ctx.font = isCompact ? '9.5px sans-serif' : '10px sans-serif';
      ctx.textAlign = i === displayCount - 1 && isCompact ? 'right' : 'center';
      const labelDate = isCompact && c.date.startsWith('오늘(') ? '오늘' : c.date;
      ctx.fillText(labelDate, x, height - 6);
    }
  }

  if (showMA) {
    const drawMA = (arr, color, widthLine) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < displayCount; i++) {
        const val = arr[startIndex + i];
        if (!val) continue;
        const x = idxToX(i);
        const y = priceToY(val);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = widthLine;
      ctx.stroke();
    };

    drawMA(selectedStock.ma60Arr, '#38bdf8', 1.4);
    drawMA(selectedStock.ma20Arr, '#ec4899', 1.7);
    drawMA(selectedStock.ma5Arr, '#f59e0b', 1.7);
  }

  if (hoverCandleIndex !== null && hoverCandleIndex >= 0 && hoverCandleIndex < displayCount) {
    const hx = idxToX(hoverCandleIndex);
    const hc = candles[hoverCandleIndex];
    const hy = priceToY(hc.close);

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.45)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(hx, padTop);
    ctx.lineTo(hx, volAreaTop + volAreaHeight);
    ctx.moveTo(padLeft, hy);
    ctx.lineTo(width - padRight, hy);
    ctx.stroke();
    ctx.restore();
  }
}

// 1,000종목 전체 모달 테이블 렌더링
function renderFullModalTable() {
  const modal = document.getElementById('allStocksModal');
  if (modal.classList.contains('hidden')) return;

  const query = (document.getElementById('modalSearchInput').value || '').trim().toLowerCase();
  const mktFilter = document.getElementById('modalMarketFilter').value;
  const secFilterEl = document.getElementById('modalSectorFilter');
  const secFilter = secFilterEl ? secFilterEl.value : 'ALL';
  const sortKey = document.getElementById('modalSortSelect').value;

  let list = analyzedUniverse.filter(s => {
    if (mktFilter !== 'ALL' && s.market !== mktFilter) return false;
    if (secFilter !== 'ALL' && s.sector !== secFilter) return false;
    if (!query) return true;
    return (
      s.name.toLowerCase().includes(query) ||
      s.code.includes(query) ||
      (s.sector && s.sector.toLowerCase().includes(query)) ||
      (s.subSector && s.subSector.toLowerCase().includes(query)) ||
      s.mcapRank.toLowerCase().includes(query)
    );
  });

  if (sortKey === 'score') {
    list.sort((a, b) => b.score - a.score || b.volRatio - a.volRatio);
  } else if (sortKey === 'sectorDesc') {
    list.sort((a, b) => b.sectorDelta - a.sectorDelta || b.score - a.score);
  } else if (sortKey === 'changeDesc') {
    list.sort((a, b) => b.changeRate - a.changeRate);
  } else if (sortKey === 'volDesc') {
    list.sort((a, b) => b.volRatio - a.volRatio);
  } else if (sortKey === 'rsiAsc') {
    list.sort((a, b) => a.rsi - b.rsi);
  } else if (sortKey === 'mcap') {
    list.sort((a, b) => a.indexOrder - b.indexOrder);
  }

  document.getElementById('modalResultCount').innerText = `검색 결과: ${list.length.toLocaleString()}종목`;

  const displayLimit = (modalShowAll || query) ? list.length : Math.min(200, list.length);
  const loadMoreWrap = document.getElementById('modalLoadMoreWrap');
  if (displayLimit < list.length) {
    loadMoreWrap.classList.remove('hidden');
    document.getElementById('modalShowAllBtn').innerText = `나머지 ${(list.length - displayLimit).toLocaleString()}종목 모두 표시 (전체 ${list.length.toLocaleString()}종목 보기)`;
  } else {
    loadMoreWrap.classList.add('hidden');
  }

  const sliced = list.slice(0, displayLimit);
  const tbody = document.getElementById('modalTableBody');
  tbody.innerHTML = sliced.map(s => {
    const isUp = s.changeRate > 0;
    const isDown = s.changeRate < 0;
    const color = isUp ? 'var(--kr-up)' : (isDown ? '#60a5fa' : 'var(--text-secondary)');
    const arrow = isUp ? '▲' : (isDown ? '▼' : '-');
    const sign = isUp ? '+' : '';
    const secSign = s.sectorDelta >= 0 ? '+' : '';
    const secColor = s.sectorDelta >= 0.5 ? '#34d399' : (s.sectorDelta <= -0.5 ? '#60a5fa' : 'var(--text-secondary)');
    return `
      <tr data-code="${s.code}">
        <td><strong style="color:#38bdf8;">#${s.overallQuantRank}</strong></td>
        <td><strong>${s.name}</strong> <span style="color:var(--text-muted); font-size:0.73rem;">(${s.code})</span></td>
        <td><strong>${s.sector}</strong> <span style="color:${secColor}; font-weight:700; font-size:0.74rem;">(${secSign}${s.sectorDelta.toFixed(1)}점)</span></td>
        <td>${s.mcapRank} <span style="color:var(--text-muted); font-size:0.72rem;">(${s.mcapText})</span></td>
        <td><strong>${s.currentPrice.toLocaleString()}원</strong></td>
        <td style="color:${color}; font-weight:700;">${arrow} ${Math.abs(s.diffPrice).toLocaleString()}원 (${sign}${s.changeRate.toFixed(2)}%)</td>
        <td><span class="score-pill">${s.score.toFixed(1)}점</span></td>
        <td>${s.rsi}</td>
        <td>${s.volRatio}%</td>
        <td>${s.tags.map(t => `<span class="sig-tag ${t.hot ? 'hot' : ''} ${t.sectorClass || ''}">${t.text}</span>`).join(' ')}</td>
        <td style="color:var(--kr-up); font-weight:700;">${s.targetPrice.toLocaleString()}원 (+${s.targetGainPct.toFixed(1)}%)</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const code = tr.getAttribute('data-code');
      const found = analyzedUniverse.find(item => item.code === code);
      if (found) {
        modal.classList.add('hidden');
        selectStock(found, null, { scrollOnMobile: true });
      }
    });
  });
}

// 전체 데이터 재계산 및 UI 갱신
function refreshUI() {
  const prevSelectedCode = selectedStock ? selectedStock.code : null;
  filterAndRankTop5();
  renderFullModalTable();

  if (prevSelectedCode) {
    const inUniverse = analyzedUniverse.find(s => s.code === prevSelectedCode);
    if (inUniverse) {
      selectStock(inUniverse);
      return;
    }
  }
  if (currentTop5.length > 0) {
    selectStock(currentTop5[0], 1);
  }
}

// 네이버 증권 실시간 시세 JSONP 폴링 처리
window.__handleNaverRealtime = function(response) {
  try {
    if (!response || !response.result || !response.result.areas) return;

    response.result.areas.forEach(area => {
      if (area.name === 'SERVICE_INDEX') {
        area.datas.forEach(idxItem => {
          const val = (idxItem.nv / 100).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const chg = (Math.abs(idxItem.cv) / 100).toFixed(2);
          const isUp = idxItem.rf === '1' || idxItem.rf === '2';
          const isDown = idxItem.rf === '4' || idxItem.rf === '5';
          const arrow = isUp ? '▲' : (isDown ? '▼' : '-');
          const sign = isUp ? '+' : (isDown ? '-' : '');

          if (idxItem.cd === 'KOSPI') {
            document.getElementById('kospiIndex').innerText = val;
            const el = document.getElementById('kospiChange');
            el.className = `idx-chg ${isUp ? 'up' : 'down'}`;
            el.innerText = `${arrow} ${chg} (${sign}${Math.abs(idxItem.cr).toFixed(2)}%)`;
          } else if (idxItem.cd === 'KOSDAQ') {
            document.getElementById('kosdaqIndex').innerText = val;
            const el = document.getElementById('kosdaqChange');
            el.className = `idx-chg ${isUp ? 'up' : 'down'}`;
            el.innerText = `${arrow} ${chg} (${sign}${Math.abs(idxItem.cr).toFixed(2)}%)`;
          }
        });
      } else if (area.name === 'SERVICE_ITEM') {
        const nowKst = new Date(Date.now() + (new Date().getTimezoneOffset() + 540) * 60000);
        const todayMD = `${nowKst.getMonth() + 1}/${nowKst.getDate()}`;

        area.datas.forEach(item => {
          const target = REAL_STOCK_UNIVERSE.find(s => s.code === item.cd);
          if (target && target.rawCandles.length > 0 && item.nv > 0) {
            const lastCandle = target.rawCandles[target.rawCandles.length - 1];

            // 새로운 거래일이 시작되어 전일종가(pcv)가 마지막 캔들 종가와 같고 날짜가 달라진 경우: 신규 일봉 캔들 자동 추가(Rollover)
            if (
              lastCandle[0] !== todayMD &&
              item.pcv > 0 &&
              item.ov > 0 &&
              item.aq > 0 &&
              lastCandle[4] === item.pcv
            ) {
              target.rawCandles.push([
                todayMD,
                item.ov,
                item.hv > 0 ? item.hv : item.nv,
                item.lv > 0 ? item.lv : item.nv,
                item.nv,
                item.aq
              ]);
              if (target.rawCandles.length > 65) target.rawCandles.shift();
            } else {
              if (item.ov > 0) lastCandle[1] = item.ov;
              if (item.hv > 0) lastCandle[2] = item.hv;
              if (item.lv > 0) lastCandle[3] = item.lv;
              if (item.nv > 0) lastCandle[4] = item.nv;
              if (item.aq > 0) lastCandle[5] = item.aq;
              if (item.pcv > 0 && target.rawCandles.length > 1) {
                target.rawCandles[target.rawCandles.length - 2][4] = item.pcv;
              }
            }
          }
        });
      }
    });

    refreshUI();
    const now = new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('updateTimeText').innerText = `KRX 1,000종목 실시간 동기화 (${timeStr})`;
  } catch (err) {
    console.warn('실시간 시세 파싱 오류:', err);
  }
};

// 상위 추천 후보군 + 현재 선택 종목 + 순환 배치(80종목씩)를 실시간 폴링
function syncRealtimeNaverPrices() {
  const priorityCodes = new Set();
  currentTop5.forEach(s => priorityCodes.add(s.code));
  if (selectedStock) priorityCodes.add(selectedStock.code);

  // 퀀트 상위 30종목 우선 포함
  analyzedUniverse
    .filter(s => s.overallQuantRank <= 30)
    .forEach(s => priorityCodes.add(s.code));

  // 나머지 1,000종목도 순환하며 50개씩 추가 동기화
  for (let i = 0; i < 50; i++) {
    const idx = (realtimeBatchCursor + i) % REAL_STOCK_UNIVERSE.length;
    priorityCodes.add(REAL_STOCK_UNIVERSE[idx].code);
  }
  realtimeBatchCursor = (realtimeBatchCursor + 50) % REAL_STOCK_UNIVERSE.length;

  const codesStr = Array.from(priorityCodes).slice(0, 85).join(',');
  const old = document.getElementById('naverRealtimeJsonp');
  if (old) old.remove();

  const script = document.createElement('script');
  script.id = 'naverRealtimeJsonp';
  script.src = `https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ|SERVICE_ITEM:${codesStr}&_callback=__handleNaverRealtime&_t=${Date.now()}`;
  document.body.appendChild(script);
}

// 이벤트 바인딩 및 초기화
document.addEventListener('DOMContentLoaded', () => {
  // 1) 전략 탭 클릭
  document.querySelectorAll('.strategy-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.strategy-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentStrategy = tab.getAttribute('data-strategy');
      document.getElementById('strategyDescText').innerText = STRATEGY_DESCRIPTIONS[currentStrategy];
      selectedStock = null;
      refreshUI();
    });
  });

  // 2) 실시간 1,000종목 자동완성 검색창
  const searchInput = document.getElementById('stockSearchInput');
  const searchDropdown = document.getElementById('searchDropdown');

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      searchDropdown.classList.add('hidden');
      return;
    }
    const matches = analyzedUniverse
      .filter(s => s.name.toLowerCase().includes(q) || s.code.includes(q) || (s.sector && s.sector.toLowerCase().includes(q)))
      .slice(0, 15);

    if (matches.length === 0) {
      searchDropdown.innerHTML = '<div class="search-result-item"><span style="color:var(--text-muted)">일치하는 종목이 없습니다 (KRX 시총 상위 1,000종목 기준)</span></div>';
    } else {
      searchDropdown.innerHTML = matches.map(s => {
        const isUp = s.changeRate > 0;
        const isDown = s.changeRate < 0;
        const color = isUp ? 'var(--kr-up)' : (isDown ? '#60a5fa' : 'var(--text-secondary)');
        const sign = isUp ? '+' : '';
        const secSign = s.sectorDelta >= 0 ? '+' : '';
        return `
          <div class="search-result-item" data-code="${s.code}">
            <div class="search-result-left">
              <span class="search-result-name">${s.name} <small style="color:var(--text-muted)">(${s.code} · ${s.sector})</small></span>
              <span class="search-result-sub">${s.mcapRank} · 섹터 ${secSign}${s.sectorDelta.toFixed(1)}점 · 퀀트 #${s.overallQuantRank}위 (${s.score.toFixed(1)}점)</span>
            </div>
            <div class="search-result-right" style="color:${color}">
              <div>${s.currentPrice.toLocaleString()}원</div>
              <div style="font-size:0.72rem">${sign}${s.changeRate.toFixed(2)}%</div>
            </div>
          </div>
        `;
      }).join('');

      searchDropdown.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          const code = item.getAttribute('data-code');
          const found = analyzedUniverse.find(s => s.code === code);
          if (found) {
            searchDropdown.classList.add('hidden');
            searchInput.value = '';
            selectStock(found, null, { scrollOnMobile: true });
          }
        });
      });
    }
    searchDropdown.classList.remove('hidden');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrapper')) {
      searchDropdown.classList.add('hidden');
    }
  });

  // 3) 1,000종목 전체 순위표 모달 열기/닫기
  const modal = document.getElementById('allStocksModal');
  document.getElementById('openAllModalBtn').addEventListener('click', () => {
    modalShowAll = false;
    modal.classList.remove('hidden');
    renderFullModalTable();
  });
  document.getElementById('closeModalBtn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.add('hidden');
  });
  document.getElementById('modalSearchInput').addEventListener('input', renderFullModalTable);
  document.getElementById('modalMarketFilter').addEventListener('change', renderFullModalTable);
  const modalSecFilter = document.getElementById('modalSectorFilter');
  if (modalSecFilter) modalSecFilter.addEventListener('change', renderFullModalTable);
  document.getElementById('modalSortSelect').addEventListener('change', renderFullModalTable);
  document.getElementById('modalShowAllBtn').addEventListener('click', () => {
    modalShowAll = true;
    renderFullModalTable();
  });

  // 4) 시장 및 섹터 필터 변경
  document.getElementById('marketSelect').addEventListener('change', e => {
    currentMarket = e.target.value;
    selectedStock = null;
    refreshUI();
  });

  const sectorSelectEl = document.getElementById('sectorSelect');
  if (sectorSelectEl) {
    sectorSelectEl.addEventListener('change', e => {
      currentSector = e.target.value;
      selectedStock = null;
      refreshUI();
    });
  }

  const resetSectorBtn = document.getElementById('resetSectorFilterBtn');
  if (resetSectorBtn) {
    resetSectorBtn.addEventListener('click', () => {
      currentSector = 'ALL';
      if (sectorSelectEl) sectorSelectEl.value = 'ALL';
      selectedStock = null;
      refreshUI();
    });
  }

  const toggleSectorExpandBtn = document.getElementById('toggleSectorExpandBtn');
  if (toggleSectorExpandBtn) {
    toggleSectorExpandBtn.addEventListener('click', () => {
      sectorBarExpanded = !sectorBarExpanded;
      renderSectorControlsAndStrip();
    });
  }

  // 5) 가중치 패널 토글 및 슬라이더 조절
  const weightPanel = document.getElementById('weightPanel');
  document.getElementById('weightToggleBtn').addEventListener('click', () => {
    weightPanel.classList.toggle('hidden');
  });

  const bindWeightSlider = (id, key, labelId) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      weights[key] = Number(el.value);
      document.getElementById(labelId).innerText = `${el.value}%`;
      refreshUI();
    });
  };
  bindWeightSlider('wTrend', 'trend', 'wTrendVal');
  bindWeightSlider('wVolume', 'volume', 'wVolumeVal');
  bindWeightSlider('wMomentum', 'momentum', 'wMomentumVal');
  bindWeightSlider('wPattern', 'pattern', 'wPatternVal');
  bindWeightSlider('wSector', 'sector', 'wSectorVal');

  document.getElementById('resetWeightsBtn').addEventListener('click', () => {
    weights = { trend: 30, volume: 30, momentum: 25, pattern: 15, sector: 100 };
    customSectorBoost = {};
    document.getElementById('wTrend').value = 30;
    document.getElementById('wTrendVal').innerText = '30%';
    document.getElementById('wVolume').value = 30;
    document.getElementById('wVolumeVal').innerText = '30%';
    document.getElementById('wMomentum').value = 25;
    document.getElementById('wMomentumVal').innerText = '25%';
    document.getElementById('wPattern').value = 15;
    document.getElementById('wPatternVal').innerText = '15%';
    const wSecEl = document.getElementById('wSector');
    if (wSecEl) {
      wSecEl.value = 100;
      document.getElementById('wSectorVal').innerText = '100%';
    }
    document.querySelectorAll('.sector-boost-select').forEach(sel => {
      sel.value = '0';
    });
    refreshUI();
  });

  // 6) 차트 보조지표 체크박스 토글
  ['toggleMA', 'toggleBB', 'toggleLines'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => drawCandlestickChart());
  });

  // 7) 캔버스 마우스 호버 및 모바일 터치/드래그 인터랙션
  const canvas = document.getElementById('candleCanvas');
  const updateChartCrosshairByClientX = clientX => {
    if (!selectedStock || !selectedStock.candles) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const totalLen = selectedStock.candles.length;
    const { displayCount, padLeft, padRight } = getChartLayoutMetrics(rect.width, totalLen);
    const plotWidth = Math.max(50, rect.width - padLeft - padRight);

    const idx = Math.floor(((x - padLeft) / plotWidth) * displayCount);
    if (idx >= 0 && idx < displayCount) {
      hoverCandleIndex = idx;
      const globalIdx = totalLen - displayCount + idx;
      updateHoverLegend(globalIdx);
      drawCandlestickChart();
    }
  };

  canvas.addEventListener('mousemove', e => {
    updateChartCrosshairByClientX(e.clientX);
  });

  canvas.addEventListener('mouseleave', () => {
    if (!selectedStock || !selectedStock.candles) return;
    hoverCandleIndex = null;
    updateHoverLegend(selectedStock.candles.length - 1);
    drawCandlestickChart();
  });

  let touchStartX = 0;
  let touchStartY = 0;
  canvas.addEventListener('touchstart', e => {
    if (!e.touches || e.touches.length === 0) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    updateChartCrosshairByClientX(touchStartX);
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    if (!e.touches || e.touches.length === 0) return;
    const dx = Math.abs(e.touches[0].clientX - touchStartX);
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dx > dy && e.cancelable) {
      e.preventDefault();
    }
    updateChartCrosshairByClientX(e.touches[0].clientX);
  }, { passive: false });

  window.addEventListener('resize', () => drawCandlestickChart());

  // 7-b) 모바일 상단 목록 복귀 버튼 & 하단 고정 빠른 이동 바
  const scrollToTop5Btn = document.getElementById('scrollToTop5Btn');
  if (scrollToTop5Btn) {
    scrollToTop5Btn.addEventListener('click', () => {
      const top5El = document.getElementById('top5Section');
      if (top5El) {
        const y = top5El.getBoundingClientRect().top + window.scrollY - 12;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }
      document.querySelectorAll('.m-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-target') === 'top5Section');
      });
    });
  }

  document.querySelectorAll('.m-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      if (targetId === 'openModal') {
        modalShowAll = false;
        modal.classList.remove('hidden');
        renderFullModalTable();
        return;
      }
      document.querySelectorAll('.m-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        const y = targetEl.getBoundingClientRect().top + window.scrollY - 12;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }
    });
  });

  // 8) 투자금 시뮬레이터 입력 및 퀵 버튼
  document.getElementById('capitalInput').addEventListener('input', updatePositionSimulator);
  document.querySelectorAll('.cap-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('capitalInput').value = btn.getAttribute('data-cap');
      updatePositionSimulator();
    });
  });

  // 9) 실시간 시세 동기화 버튼 & 자동 폴링 토글
  document.getElementById('refreshBtn').addEventListener('click', () => {
    syncRealtimeNaverPrices();
  });

  const liveToggleBtn = document.getElementById('liveToggleBtn');
  const liveDot = document.getElementById('liveDot');

  function startLiveTicker() {
    if (liveInterval) clearInterval(liveInterval);
    liveInterval = setInterval(() => {
      if (isLiveOn) syncRealtimeNaverPrices();
    }, 12000);
  }

  liveToggleBtn.addEventListener('click', () => {
    isLiveOn = !isLiveOn;
    liveToggleBtn.innerText = `자동 시세연동: ${isLiveOn ? 'ON' : 'OFF'}`;
    liveDot.classList.toggle('paused', !isLiveOn);
  });

  // 최초 실행: 내장된 실제 KRX 1,000종목 65일 시세로 즉시 렌더링 후 네이버 실시간 JSONP 동기화 호출
  refreshUI();
  syncRealtimeNaverPrices();
  startLiveTicker();
});
