#!/usr/bin/env python3
import urllib.request
import json
import pypinyin
from pathlib import Path

# Fetch 12306 official station dictionary
req = urllib.request.Request(
    "https://kyfw.12306.cn/otn/resources/js/framework/station_name.js",
    headers={"User-Agent": "Mozilla/5.0"}
)
content = urllib.request.urlopen(req).read().decode("utf-8")

st_12306 = {}
for entry in content.split("@"):
    if not entry.strip():
        continue
    parts = entry.split("|")
    if len(parts) >= 5:
        st_12306[parts[1]] = parts[3]

ROOT = Path(__file__).resolve().parent.parent
with open(ROOT / "data/city_en.json", encoding="utf-8") as f:
    city_en = json.load(f)

# Well known specials / English railway overrides
SPECIALS = {
    "香港西九龙": "Hong Kong West Kowloon",
    "香港": "Hong Kong",
    "拉萨": "Lhasa",
    "乌鲁木齐": "Urumqi",
    "乌鲁木齐南": "Urumqi South",
    "乌鲁木齐西": "Urumqi West",
    "乌鲁木齐东": "Urumqi East",
    "乌鲁木齐北": "Urumqi North",
    "呼和浩特": "Hohhot",
    "呼和浩特东": "Hohhot East",
    "哈尔滨": "Harbin",
    "哈尔滨西": "Harbin West",
    "哈尔滨东": "Harbin East",
    "哈尔滨北": "Harbin North",
    "香格里拉": "Shangri-La",
    "日喀则": "Shigatse",
    "日喀则西": "Shigatse West",
    "林芝": "Nyingchi",
    "那曲": "Nagqu",
    "山南": "Shannan",
    "格尔木": "Golmud",
    "喀什": "Kashgar",
    "和田": "Hotan",
    "阿克苏": "Aksu",
    "库尔勒": "Korla",
    "吐鲁番": "Turpan",
    "吐鲁番北": "Turpan North",
    "哈密": "Hami",
    "阿图什": "Artux",
    "伊宁": "Yining",
    "博乐": "Bole",
    "阿拉山口": "Alashankou",
    "霍尔果斯": "Horgos",
    "二连": "Erlian",
    "满洲里": "Manzhouli",
    "海拉尔": "Hailar",
    "包头": "Baotou",
    "包头东": "Baotou East",
    "鄂尔多斯": "Ordos",
    "乌兰察布": "Ulanqab",
    "乌兰浩特": "Ulanhot",
    "锡林浩特": "Xilinhot",
    "巴彦淖尔": "Bayan Nur",
    "大同": "Datong",
    "大同南": "Datong South",
    "银川": "Yinchuan",
    "西宁": "Xining",
    "郑州航空港": "Zhengzhou Airport",
    "八达岭长城": "Badaling Great Wall",
    "苏州园区": "Suzhou Industrial Park",
    "苏州新区": "Suzhou New District",
    "无锡新区": "Wuxi New District",
    "广州大学城": "Guangzhou Daxuecheng",
    "白云机场北": "Baiyun Airport North",
    "白云机场南": "Baiyun Airport South",
    "天府机场": "Tianfu Airport",
    "双流机场": "Shuangliu Airport",
    "江北机场": "Jiangbei Airport",
    "深圳机场": "Shenzhen Airport",
    "深圳机场北": "Shenzhen Airport North",
    "珠海机场": "Zhuhai Airport",
    "青岛机场": "Qingdao Airport",
    "北京丰台": "Beijing Fengtai",
    "上海虹桥": "Shanghai Hongqiao",
    "武汉": "Wuhan",
    "汉口": "Hankou",
    "武昌": "Wuchang",
    "福田": "Futian",
    "沙坪坝": "Shapingba",
    "广州白云": "Guangzhou Baiyun",
}

CITY_SPELLINGS = {
    "哈尔滨": "Harbin",
    "呼和浩特": "Hohhot",
    "乌鲁木齐": "Urumqi",
    "拉萨": "Lhasa",
    "香港": "Hong Kong",
}

city_keys = sorted([k for k in city_en.keys() if len(k) >= 2], key=lambda x: len(x), reverse=True)

# Non-directional names ending with 东/南/西/北 where the character is part of the proper name
PROPER_DIRECTION_NAMES = {
    "济南", "淮南", "丹东", "定南", "苍南", "渭南", "陇西", "阳西", "肥西", 
    "启东", "淮北", "海东", "城阳", "邵东", "祁东", "阳东", "乐东", "宁东", 
    "巴东", "林东", "惠东", "肇东", "克东", "郁南", "商南", "巴南", "龙南", 
    "潼南", "陇南", "莒南", "洮南", "潮南", "灌南", "阜南", "山南", "越西", 
    "林西", "郧西", "靖西", "定西", "莱西", "黔西", "通北"
}

def pinyin_of_sub(zh, full_zh=None):
    if full_zh and full_zh in st_12306 and full_zh.endswith(zh):
        full_py = st_12306[full_zh]
        pre_len = len(full_zh) - len(zh)
        pre_zh = full_zh[:pre_len]
        pre_py = "".join([p[0] for p in pypinyin.pinyin(pre_zh, style=pypinyin.NORMAL)])
        if full_py.lower().startswith(pre_py.lower()):
            sub_py = full_py[len(pre_py):]
            if sub_py:
                return sub_py.capitalize()
    if zh in st_12306:
        return st_12306[zh].capitalize()
    py_chars = [p[0] for p in pypinyin.pinyin(zh, style=pypinyin.NORMAL)]
    return "".join(py_chars).capitalize()

def translate(zh):
    if zh in SPECIALS:
        return SPECIALS[zh]

    name = zh[:-1] if zh.endswith("站") else zh

    # Airport / special suffixes
    for suf, word in [
        ("国际机场", "International Airport"),
        ("机场北", "Airport North"),
        ("机场南", "Airport South"),
        ("机场东", "Airport East"),
        ("机场西", "Airport West"),
        ("机场", "Airport"),
        ("港", "Port"),
    ]:
        if name.endswith(suf) and len(name) > len(suf):
            base = name[:-len(suf)]
            return f"{translate(base)} {word}"

    # Cardinal directions
    for suf, word in [("东", "East"), ("南", "South"), ("西", "West"), ("北", "North")]:
        if name.endswith(suf) and len(name) > len(suf):
            if name in PROPER_DIRECTION_NAMES:
                break
            base = name[:-len(suf)]
            return f"{translate(base)} {word}"

    # Exact match in city_en
    if name in CITY_SPELLINGS:
        return CITY_SPELLINGS[name]
    if name in city_en:
        return city_en[name]

    # Starts with a known city (e.g. 广州白云, 北京大兴, 上海松江, 深圳坪山)
    for ck in city_keys:
        if name.startswith(ck) and len(name) > len(ck):
            sub = name[len(ck):]
            c_en = CITY_SPELLINGS.get(ck, city_en[ck])
            sub_en = pinyin_of_sub(sub, name)
            return f"{c_en} {sub_en}"

    return pinyin_of_sub(name)

# Collect all stations
all_stns = set()
with open(ROOT / "data/stations.json", encoding="utf-8") as f:
    st_raw = json.load(f)
for name in st_raw.get("byName", {}).keys():
    all_stns.add(name)

if (ROOT / "output/atlas-v2-shared.json").exists():
    with open(ROOT / "output/atlas-v2-shared.json", encoding="utf-8") as f:
        shared = json.load(f)
    for s in shared["station_table"]:
        all_stns.add(s["zh"])

out_map = {}
for s in sorted(all_stns):
    out_map[s] = translate(s)

out_file = ROOT / "data/station_en.json"
with open(out_file, "w", encoding="utf-8") as f:
    json.dump(out_map, f, ensure_ascii=False, indent=2)

print(f"Wrote {len(out_map)} station translations to {out_file}")
