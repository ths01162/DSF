#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KRX 시가총액 상위 1,000대 종목 (KOSPI 500 + KOSDAQ 500)
실제 65거래일 일봉(OHLCV) 및 네이버 증권 WICS 업종(섹터) 자동 최신화 스크립트
- 외부 패키지 설치 불필요 (Python 3 표준 라이브러리만 사용)
- GitHub Actions 스케줄러 및 로컬 환경 모두 지원
"""

import json
import math
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

ETF_BRANDS = (
    "KODEX", "TIGER", "KBSTAR", "RISE", "ACE", "SOL", "HANARO",
    "KOSEF", "ARIRANG", "PLUS", "TIMEFOLIO", "WOORI", "히어로즈",
    "마이티", "파워", "대신343", "엔투", "코세프", "에셋플러스", "UNICORN",
    "VITA", "TREX", "HK", "마이다스", "더제이", "글로벌X", "옥토", "원큐",
    "1Q", "ITF", "네비게이터", "스마트", "포커스", "밸류", "신한", "미래에셋",
    "삼성", "키움", "한투", "투모로우"
)


def fetch_json(url, timeout=10):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_text(url, encoding="utf-8", timeout=10):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode(encoding, errors="ignore")


def normalize_sector_name(raw_name: str) -> str:
    if re.search(r"반도체", raw_name):
        return "반도체·장비"
    if re.search(r"전기제품|에너지장비|축전지|2차전지", raw_name):
        return "2차전지·전력기기"
    if re.search(r"제약|생물공학|건강관리|생명과학|의료", raw_name):
        return "제약·바이오·헬스"
    if re.search(r"은행|증권|보험|카드|금융|창업투자|투신|리츠", raw_name):
        return "금융·은행·증권"
    if re.search(r"자동차", raw_name):
        return "자동차·부품"
    if re.search(r"조선|우주항공|국방|방산", raw_name):
        return "조선·방산·항공"
    if re.search(r"기계|건설|건축|엔지니어링|시멘트|상사|무역", raw_name):
        return "기계·건설·인프라"
    if re.search(r"양방향|미디어|인터넷|게임|소프트웨어|IT서비스|방송|엔터|광고|영화|출판|교육", raw_name):
        return "IT·플랫폼·게임·엔터"
    if re.search(r"전자장비|디스플레이|핸드셋|전기장비|컴퓨터|통신장비|사무용전자|전자제품|IT하드웨어", raw_name):
        return "IT하드웨어·전자부품"
    if re.search(r"화학|철강|비철금속|석유|가스|종이|목재|포장재|광물|에너지소재", raw_name):
        return "화학·철강·에너지소재"
    if re.search(r"화장품|섬유|의류|백화점|소매|유통|가정용|가구|호텔|레저|생물|소비재", raw_name):
        return "화장품·유통·소비재"
    if re.search(r"식품|음료|담배|농업|식료", raw_name):
        return "음식료·필수소비재"
    if re.search(r"해운|항공|육상|운수|운송|물류", raw_name):
        return "해운·항공·운송"
    if re.search(r"유틸리티|통신", raw_name):
        return "통신·유틸리티"
    if re.search(r"복합기업|지주", raw_name):
        return "지주·복합기업"
    return "기계·건설·인프라"


def fallback_sector_by_name(name: str):
    if re.search(r"반도체|테크|세미|칩|실리콘|마이크로|원익|주성|피에스케이|리노|이오테크|한미반도체", name):
        return "반도체·장비", "반도체와반도체장비"
    if re.search(r"바이오|제약|파마|메디|젠|셀|큐어|테라퓨틱스|헬스|진단|에이비엘|알테오젠|리가켐|삼천당|보로노이|루닛", name):
        return "제약·바이오·헬스", "생물공학"
    if re.search(r"에코프로|엘앤에프|에너지|배터리|엔켐|피엔티|일진|성일|나노신소재|대주전자", name):
        return "2차전지·전력기기", "전기제품"
    if re.search(r"금융|은행|증권|보험|화재|생명|캐피탈|신한|KB|하나|우리", name):
        return "금융·은행·증권", "금융"
    if re.search(r"엔터|게임|소프트|웹툰|카카오|NAVER|크래프톤|펄어비스|넷마블|스튜디오|디어유|하이브|에스엠|JYP|와이지", name):
        return "IT·플랫폼·게임·엔터", "IT·콘텐츠"
    if re.search(r"중공업|조선|방산|에어로|오션|디펜스|항공|현대로템|LIG|한화시스템", name):
        return "조선·방산·항공", "우주항공과국방"
    if re.search(r"홀딩스|지주", name):
        return "지주·복합기업", "복합기업"
    return "IT하드웨어·전자부품", "전자장비와기기"


def is_common_operating_stock(item: dict) -> bool:
    code = str(item.get("itemCode", ""))
    name = str(item.get("stockName", ""))
    etn_code = str(item.get("stockEndType", ""))
    if etn_code and etn_code != "stock":
        return False
    if not re.match(r"^[0-9]{5}0$", code):
        return False
    for prefix in ETF_BRANDS:
        if name.startswith(prefix + " "):
            return False
    if re.search(r"스팩|제[0-9]+호|리츠|인프라|맥쿼리|우B|우C|우선주|채권|선물|레버리지|인버스|커버드콜|액티브|합성|ETN|ETF", name):
        return False
    if re.search(r"(우|우B|우C|\(전환\))$", name):
        return False
    return True


def format_mcap_text(raw_eok) -> str:
    try:
        num = int(str(raw_eok).replace(",", ""))
    except ValueError:
        return f"{raw_eok}억원"
    if num >= 10000:
        jo = num // 10000
        rem = num % 10000
        return f"{jo:,}조 {rem:,}억원" if rem > 0 else f"{jo:,}조원"
    return f"{num:,}억원"


def fetch_top500_by_market(market_name: str, target_count: int = 500):
    collected = []
    seen = set()
    page = 1
    while len(collected) < target_count and page <= 18:
        url = f"https://m.stock.naver.com/api/stocks/marketValue/{market_name}?page={page}&pageSize=100"
        data = fetch_json(url)
        stocks = data.get("stocks", [])
        if not stocks:
            break
        for st in stocks:
            code = str(st.get("itemCode", ""))
            if code in seen:
                continue
            if is_common_operating_stock(st):
                seen.add(code)
                rank = len(collected) + 1
                collected.append({
                    "code": code,
                    "name": str(st.get("stockName", "")).strip(),
                    "market": market_name,
                    "mcapRank": f"{market_name} 시총 {rank}위",
                    "mcapText": format_mcap_text(st.get("marketValue", "0")),
                })
                if len(collected) >= target_count:
                    break
        page += 1
    return collected


def fetch_sector_map():
    code_to_sector = {}
    code_to_sub = {}
    try:
        ind_resp = fetch_json("https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100")
        groups = ind_resp.get("groups", [])
    except Exception as e:
        print(f"[WARN] 업종 목록 조회 실패: {e}")
        return code_to_sector, code_to_sub

    def fetch_group_stocks(g):
        no = g.get("no")
        gname = str(g.get("name", ""))
        total_cnt = int(g.get("totalCount", 100))
        pages = max(1, math.ceil(total_cnt / 100.0))
        pairs = []
        for p in range(1, pages + 1):
            try:
                u = f"https://m.stock.naver.com/api/stocks/industry/{no}?page={p}&pageSize=100"
                r = fetch_json(u, timeout=8)
                for st in r.get("stocks", []):
                    c = str(st.get("itemCode", ""))
                    if c:
                        pairs.append((c, gname))
            except Exception:
                pass
        return pairs

    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = [ex.submit(fetch_group_stocks, g) for g in groups]
        for fut in as_completed(futures):
            for c, sub in fut.result():
                code_to_sub[c] = sub
                code_to_sector[c] = normalize_sector_name(sub)

    return code_to_sector, code_to_sub


def fetch_65_candles(stock: dict):
    code = stock["code"]
    url = f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count=65&requestType=0"
    for attempt in range(3):
        try:
            xml_text = fetch_text(url, encoding="utf-8", timeout=8)
            candles = []
            for m in re.finditer(r'data="([0-9]{8})\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)"', xml_text):
                dt = m.group(1)
                o, h, l, c, v = int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6))
                if c <= 0:
                    continue
                if o <= 0:
                    o, h, l = c, c, c
                mm = int(dt[4:6])
                dd = int(dt[6:8])
                candles.append([f"{mm}/{dd}", o, h, l, c, v])
            if len(candles) >= 15:
                stock["rawCandles"] = candles
                return stock
        except Exception:
            time.sleep(0.25 * (attempt + 1))
    return None


def main():
    start_ts = time.time()
    print("1. KOSPI 시총 상위 500 + KOSDAQ 시총 상위 500 보통주 수집 중...")
    kospi500 = fetch_top500_by_market("KOSPI", 500)
    kosdaq500 = fetch_top500_by_market("KOSDAQ", 500)
    universe = kospi500 + kosdaq500
    print(f"   -> 수집 완료: KOSPI {len(kospi500)}종목 + KOSDAQ {len(kosdaq500)}종목 = 총 {len(universe)}종목")

    print("2. 네이버 증권 WICS 79개 업종(섹터) 매핑 데이터 수집 중...")
    code_to_sector, code_to_sub = fetch_sector_map()
    for st in universe:
        c = st["code"]
        if c in code_to_sector:
            st["sector"] = code_to_sector[c]
            st["subSector"] = code_to_sub[c]
        else:
            sec, sub = fallback_sector_by_name(st["name"])
            st["sector"] = sec
            st["subSector"] = sub

    print("3. 1,000개 종목의 최근 65거래일 일봉(OHLCV) 데이터 병렬 수집 중...")
    results_map = {}
    with ThreadPoolExecutor(max_workers=20) as ex:
        fut_map = {ex.submit(fetch_65_candles, st): st["code"] for st in universe}
        for fut in as_completed(fut_map):
            res = fut.result()
            if res:
                results_map[res["code"]] = res

    ordered = [results_map[st["code"]] for st in universe if st["code"] in results_map]
    print(f"   -> 일봉 수집 성공: {len(ordered)} / {len(universe)} 종목")

    if len(ordered) < 950:
        raise RuntimeError(f"수집된 종목 수({len(ordered)})가 기준치(950) 미만입니다. 업데이트를 중단합니다.")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = os.path.join(repo_root, "stocks_data.js")

    header_comment = (
        "// KRX 1,000대 종목 (KOSPI 시총 상위 500종목 + KOSDAQ 시총 상위 500종목 = 총 1,000종목) "
        "실제 65거래일 일봉 및 업종(섹터) 데이터\n"
    )
    json_str = json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(header_comment)
        f.write(f"const REAL_STOCK_UNIVERSE = {json_str};\n")

    elapsed = time.time() - start_ts
    print(f"4. stocks_data.js 저장 완료! ({len(ordered)}종목, 소요시간: {elapsed:.1f}초)")


if __name__ == "__main__":
    main()
