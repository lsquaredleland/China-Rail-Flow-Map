use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const CORE: &[&str] = &[
    "北京",
    "天津",
    "上海",
    "重庆",
    "石家庄",
    "唐山",
    "秦皇岛",
    "邯郸",
    "邢台",
    "保定",
    "张家口",
    "承德",
    "沧州",
    "廊坊",
    "衡水",
    "太原",
    "大同",
    "阳泉",
    "长治",
    "晋城",
    "朔州",
    "晋中",
    "运城",
    "忻州",
    "临汾",
    "吕梁",
    "呼和浩特",
    "包头",
    "乌海",
    "赤峰",
    "通辽",
    "鄂尔多斯",
    "呼伦贝尔",
    "巴彦淖尔",
    "乌兰察布",
    "沈阳",
    "大连",
    "鞍山",
    "抚顺",
    "本溪",
    "丹东",
    "锦州",
    "营口",
    "阜新",
    "辽阳",
    "盘锦",
    "铁岭",
    "朝阳",
    "葫芦岛",
    "长春",
    "吉林",
    "四平",
    "辽源",
    "通化",
    "白山",
    "松原",
    "白城",
    "哈尔滨",
    "齐齐哈尔",
    "鸡西",
    "鹤岗",
    "双鸭山",
    "大庆",
    "伊春",
    "佳木斯",
    "七台河",
    "牡丹江",
    "黑河",
    "绥化",
    "南京",
    "无锡",
    "徐州",
    "常州",
    "苏州",
    "南通",
    "连云港",
    "淮安",
    "盐城",
    "扬州",
    "镇江",
    "泰州",
    "宿迁",
    "杭州",
    "宁波",
    "温州",
    "嘉兴",
    "湖州",
    "绍兴",
    "金华",
    "衢州",
    "舟山",
    "台州",
    "丽水",
    "合肥",
    "芜湖",
    "蚌埠",
    "淮南",
    "马鞍山",
    "淮北",
    "铜陵",
    "安庆",
    "黄山",
    "滁州",
    "阜阳",
    "宿州",
    "六安",
    "亳州",
    "池州",
    "宣城",
    "福州",
    "厦门",
    "莆田",
    "三明",
    "泉州",
    "漳州",
    "南平",
    "龙岩",
    "宁德",
    "南昌",
    "景德镇",
    "萍乡",
    "九江",
    "新余",
    "鹰潭",
    "赣州",
    "吉安",
    "宜春",
    "抚州",
    "上饶",
    "济南",
    "青岛",
    "淄博",
    "枣庄",
    "东营",
    "烟台",
    "潍坊",
    "济宁",
    "泰安",
    "威海",
    "日照",
    "临沂",
    "德州",
    "聊城",
    "滨州",
    "菏泽",
    "郑州",
    "开封",
    "洛阳",
    "平顶山",
    "安阳",
    "鹤壁",
    "新乡",
    "焦作",
    "濮阳",
    "许昌",
    "漯河",
    "三门峡",
    "南阳",
    "商丘",
    "信阳",
    "周口",
    "驻马店",
    "武汉",
    "黄石",
    "十堰",
    "宜昌",
    "襄阳",
    "鄂州",
    "荆门",
    "孝感",
    "荆州",
    "黄冈",
    "咸宁",
    "随州",
    "长沙",
    "株洲",
    "湘潭",
    "衡阳",
    "邵阳",
    "岳阳",
    "常德",
    "张家界",
    "益阳",
    "郴州",
    "永州",
    "怀化",
    "娄底",
    "广州",
    "韶关",
    "深圳",
    "珠海",
    "汕头",
    "佛山",
    "江门",
    "湛江",
    "茂名",
    "肇庆",
    "惠州",
    "梅州",
    "汕尾",
    "河源",
    "阳江",
    "清远",
    "东莞",
    "中山",
    "潮州",
    "揭阳",
    "云浮",
    "南宁",
    "柳州",
    "桂林",
    "梧州",
    "北海",
    "防城港",
    "钦州",
    "贵港",
    "玉林",
    "百色",
    "贺州",
    "河池",
    "来宾",
    "崇左",
    "海口",
    "三亚",
    "成都",
    "自贡",
    "攀枝花",
    "泸州",
    "德阳",
    "绵阳",
    "广元",
    "遂宁",
    "内江",
    "乐山",
    "南充",
    "眉山",
    "宜宾",
    "广安",
    "达州",
    "雅安",
    "巴中",
    "资阳",
    "贵阳",
    "六盘水",
    "遵义",
    "安顺",
    "毕节",
    "铜仁",
    "昆明",
    "曲靖",
    "玉溪",
    "保山",
    "昭通",
    "丽江",
    "普洱",
    "临沧",
    "拉萨",
    "日喀则",
    "昌都",
    "林芝",
    "山南",
    "那曲",
    "西安",
    "铜川",
    "宝鸡",
    "咸阳",
    "渭南",
    "延安",
    "汉中",
    "榆林",
    "安康",
    "商洛",
    "兰州",
    "嘉峪关",
    "金昌",
    "白银",
    "天水",
    "武威",
    "张掖",
    "平凉",
    "酒泉",
    "庆阳",
    "定西",
    "陇南",
    "西宁",
    "海东",
    "银川",
    "石嘴山",
    "吴忠",
    "固原",
    "中卫",
    "乌鲁木齐",
    "克拉玛依",
    "吐鲁番",
    "哈密",
    "雄安",
    "香港",
];

const ALIAS: &[(&str, &str)] = &[
    ("上海松江", "上海"),
    ("安亭北", "上海"),
    ("安亭西", "上海"),
    ("金山北", "上海"),
    ("练塘", "上海"),
    ("南翔北", "上海"),
    ("南翔", "上海"),
    ("清河", "北京"),
    ("大兴机场", "北京"),
    ("密云", "北京"),
    ("密云北", "北京"),
    ("静海", "天津"),
    ("宝坻", "天津"),
    ("宝坻北", "天津"),
    ("宝坻南", "天津"),
    ("滨海", "天津"),
    ("滨海北", "天津"),
    ("滨海西", "天津"),
    ("滨海港", "天津"),
    ("武清", "天津"),
    ("蓟州", "天津"),
    ("蓟州北", "天津"),
    ("塘沽", "天津"),
    ("于家堡", "天津"),
    ("沙坪坝", "重庆"),
    ("江北机场", "重庆"),
    ("璧山", "重庆"),
    ("汉口", "武汉"),
    ("武昌", "武汉"),
    ("福田", "深圳"),
    ("光明城", "深圳"),
    ("增城", "广州"),
    ("庆盛", "广州"),
    ("天府机场", "成都"),
    ("双流机场", "成都"),
    ("安州", "绵阳"),
    ("鄠邑", "西安"),
    ("临潼", "西安"),
    ("江宁", "南京"),
    ("江宁西", "南京"),
    ("溧水", "南京"),
    ("富阳", "杭州"),
    ("富阳西", "杭州"),
    ("临安", "杭州"),
    ("临平", "杭州"),
    ("临平南", "杭州"),
    ("阳澄湖", "苏州"),
    ("花桥", "昆山"),
    ("惠山", "无锡"),
    ("金坛", "常州"),
    ("武进", "常州"),
    ("戚墅堰", "常州"),
    ("红岛", "青岛"),
    ("城阳", "青岛"),
    ("即墨北", "青岛"),
    ("即墨", "青岛"),
    ("章丘", "济南"),
    ("长清", "济南"),
    ("偃师", "洛阳"),
    ("正定机场", "石家庄"),
    ("山海关", "秦皇岛"),
    ("北戴河", "秦皇岛"),
    ("徐水", "保定"),
    ("白洋淀", "雄安"),
    ("白沟", "雄安"),
    ("辽中", "沈阳"),
    ("金州", "大连"),
    ("金普", "大连"),
    ("普兰店", "大连"),
    ("阿城", "哈尔滨"),
    ("阿城北", "哈尔滨"),
    ("双城堡", "哈尔滨"),
    ("呼兰北", "哈尔滨"),
    ("鲅鱼圈", "营口"),
    ("辽宁朝阳", "朝阳"),
    ("兖州", "济宁"),
    ("泰山", "泰安"),
    ("蓬莱", "烟台"),
    ("牟平", "烟台"),
    ("惠阳", "惠州"),
    ("仲恺", "惠州"),
    ("潮阳", "汕头"),
    ("顺德", "佛山"),
    ("顺德学院", "佛山"),
    ("北滘", "佛山"),
    ("陈村", "佛山"),
    ("容桂", "佛山"),
    ("三水", "佛山"),
    ("三水南", "佛山"),
    ("三水北", "佛山"),
    ("高明", "佛山"),
    ("新会", "江门"),
    ("鼎湖东", "肇庆"),
    ("鼎湖山", "肇庆"),
    ("长乐", "福州"),
    ("长乐东", "福州"),
    ("涵江", "莆田"),
    ("泉港", "泉州"),
    ("延平", "南平"),
    ("江都", "扬州"),
    ("赣榆", "连云港"),
    ("海门", "南通"),
    ("奉化", "宁波"),
    ("秦王川", "兰州"),
    ("河东机场", "银川"),
    ("龙洞堡", "贵阳"),
    ("吴圩机场", "南宁"),
    ("田阳", "百色"),
    ("宜州", "河池"),
    ("南溪", "宜宾"),
    ("繁昌", "芜湖"),
    ("繁昌西", "芜湖"),
    // v2.1 (C-class intercity corridors, 2026-10-28): district / urban-area
    // stations of the intercity networks folded into the city they serve.
    ("番禺", "广州"),
    ("花都", "广州"),
    ("白云机场东", "广州"),
    ("白云机场北", "广州"),
    ("竹料", "广州"),
    ("岑村", "广州"),
    ("花城街", "广州"),
    ("花山镇", "广州"),
    ("乐同", "广州"),
    ("神山", "广州"),
    ("江高", "广州"),
    ("白云湖", "广州"),
    ("狮岭", "广州"),
    ("龙洞", "广州"),
    ("科韵路", "广州"),
    ("琶洲", "广州"),
    ("帽峰山", "广州"),
    ("大源", "广州"),
    ("九佛", "广州"),
    ("新龙", "广州"),
    ("镇龙", "广州"),
    ("佛塱", "广州"),
    ("深井", "广州"),
    ("东环", "广州"),
    ("大石", "广州"),
    ("大石东", "广州"),
    ("官桥", "广州"),
    ("官桥北", "广州"),
    ("钟落潭", "广州"),
    ("钟落潭东", "广州"),
    ("化龙", "广州"),
    ("化龙南", "广州"),
    ("新塘南", "广州"),
    ("永宁北", "广州"),
    ("永宁南", "广州"),
    ("亦庄", "北京"),
    ("平湖", "深圳"),
    ("沙井西", "深圳"),
    ("福海西", "深圳"),
    ("狮山", "佛山"),
    ("狮山北", "佛山"),
    ("张槎", "佛山"),
    ("北滘西", "佛山"),
    ("云东海", "佛山"),
    ("顺德北", "佛山"),
    ("明珠", "珠海"),
    ("前山", "珠海"),
    ("唐家湾", "珠海"),
    ("凤凰机场", "三亚"),
    ("亚龙湾", "三亚"),
    ("崖州", "三亚"),
    ("美兰", "海口"),
    ("惠环", "惠州"),
    ("陈江", "惠州"),
    ("陈江南", "惠州"),
    ("沥林", "惠州"),
    ("沥林北", "惠州"),
    ("龙丰", "惠州"),
    ("小金口", "惠州"),
    ("云山", "惠州"),
    ("西湖东", "惠州"),
    ("清城", "清远"),
    ("洲心", "清远"),
    ("飞霞", "清远"),
    ("燕湖", "清远"),
    ("银盏", "清远"),
    ("龙塘镇", "清远"),
    ("端州", "肇庆"),
    ("大旺", "四会"),
    ("宋城路", "开封"),
    ("孟庄", "郑州"),
    ("南曹", "郑州"),
    ("贾鲁河", "郑州"),
    ("运粮河", "郑州"),
    ("绿博园", "郑州"),
    ("麓谷", "长沙"),
    ("谷山", "长沙"),
    ("观沙岭", "长沙"),
    ("开福寺", "长沙"),
    ("尖山", "长沙"),
    ("八方山", "长沙"),
    ("温江", "成都"),
    ("郫县", "成都"),
    ("犀浦", "成都"),
    ("安德", "成都"),
    ("羊马", "成都"),
    ("西来", "成都"),
    ("姚渡", "成都"),
    ("三星堆", "广汉"),
    ("离堆公园", "都江堰"),
    ("福利区", "兰州"),
    ("西固", "兰州"),
    ("龙嘉", "长春"),
    ("昆阳", "昆明"),
    ("大洋", "兰溪"),
    ("金月湾", "东方"),
    ("迎宾路", "都江堰"),
    // v2.2 (S-class stations): urban stations of the 长株潭 / 成灌 / 北京市郊 /
    // 海南环岛 / 珠机 / 贵开 S-lines folded into the city they serve.
    ("树木岭", "长沙"),
    ("香樟路", "长沙"),
    ("湘府路", "长沙"),
    ("洞井", "长沙"),
    ("先锋", "长沙"),
    ("芙蓉南", "长沙"),
    ("暮云", "长沙"),
    ("昭山", "湘潭"),
    ("荷塘", "湘潭"),
    ("板塘", "湘潭"),
    ("田心东", "株洲"),
    ("大丰", "株洲"),
    ("红光镇", "成都"),
    ("郫县西", "成都"),
    ("房山东", "北京"),
    ("良乡", "北京"),
    ("衙门口东", "北京"),
    ("乔庄东", "北京"),
    ("中仓", "北京"),
    ("后吕村", "北京"),
    ("长流", "海口"),
    ("秀英", "海口"),
    ("城西", "海口"),
    ("天涯海角", "三亚"),
    ("崖州湾", "三亚"),
    ("南山北", "三亚"),
    ("湾仔北", "珠海"),
    ("横琴", "珠海"),
    ("十字门", "珠海"),
    ("三灶东", "珠海"),
    ("花溪大学城", "贵阳"),
    ("花溪南", "贵阳"),
    ("洛湾三江", "贵阳"),
    ("百宜", "贵阳"),
    ("南江", "开阳"),
    ("步行街", "彭州"),
];

fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}
fn nchars(s: &str) -> usize {
    s.chars().count()
}
fn drop_last(s: &str) -> String {
    let mut v: Vec<char> = s.chars().collect();
    v.pop();
    v.into_iter().collect()
}

fn city2(name: &str) -> (String, &'static str) {
    let mut n = clean(name);
    if n.ends_with('站') {
        n = drop_last(&n);
    }
    for (a, b) in ALIAS {
        if n == *a {
            return (b.to_string(), "alias");
        }
    }
    let mut base = n;
    if base.ends_with('市') && nchars(&base) >= 3 {
        base = drop_last(&base);
    }
    if base.ends_with('县') && nchars(&base) >= 3 {
        base = drop_last(&base);
    }
    let mut best: Option<&str> = None;
    for core in CORE {
        if base.starts_with(core)
            && nchars(&base) > nchars(core)
            && best.map(|b| nchars(core) > nchars(b)).unwrap_or(true)
        {
            best = Some(core);
        }
    }
    if let Some(core) = best {
        return (core.to_string(), "prefix");
    }
    if nchars(&base) >= 3 && ['东', '南', '西', '北'].contains(&base.chars().last().unwrap()) {
        return (drop_last(&base), "suffix");
    }
    (base, "self")
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = s.len();
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    }
}

#[derive(Deserialize)]
struct Deliverable {
    // Part of the timetable file schema; not read by this audit.
    #[allow(dead_code)]
    date: Option<String>,
    trains: Vec<Train>,
}
#[derive(Deserialize, Clone)]
struct Train {
    #[serde(default)]
    train_no: String,
    code: String,
    #[serde(rename = "class")]
    train_class: String,
    stops: Vec<Stop>,
}
#[derive(Deserialize, Clone)]
struct Stop {
    name: String,
    arrive: String,
    depart: String,
}
fn mins(s: &str) -> Option<i64> {
    let t = s.trim();
    if t == "----" || t.is_empty() {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

/// Travel minutes from departing stop `from` to arriving at stop `to`,
/// advancing the clock by whole days whenever a stop time wraps past midnight.
#[allow(clippy::needless_range_loop)]
fn travel_time(stops: &[Stop], from: usize, to: usize) -> Option<i64> {
    let start = mins(&stops[from].depart)?;
    let mut clock = start;
    let mut prev_tod = start;
    for j in (from + 1)..=to {
        let arr = match mins(&stops[j].arrive) {
            Some(a) => a,
            None => continue,
        };
        let mut abs = clock - prev_tod + arr;
        while abs < clock {
            abs += 1440;
        }
        clock = abs;
        prev_tod = arr;
        if j == to {
            return Some(clock - start);
        }
        if let Some(dep) = mins(&stops[j].depart) {
            let mut dabs = clock - prev_tod + dep;
            while dabs < clock {
                dabs += 1440;
            }
            clock = dabs;
            prev_tod = dep;
        }
    }
    None
}
#[derive(Default, Clone)]
struct DestStats {
    total: u64,
    fast: u64,
    terminating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    first: usize,
}

/// city2 plus two adjudicated overrides for Chengdu-area name collisions:
/// 朝阳湖 is the HSR station for 蒲江 county (Chengdu) — the v2 prefix rule
/// misfires it into 朝阳, Liaoning. 沙湾南 is 沙湾 district of 乐山 — folding
/// it into plain 沙湾 merges it with 沙湾, Xinjiang.
fn city_of(station_name: &str) -> String {
    match station_name {
        "朝阳湖" => "蒲江".to_string(),
        "沙湾南" => "乐山".to_string(),
        "安靖" => "成都".to_string(),
        _ => city2(station_name).0,
    }
}

#[derive(Deserialize)]
struct PPFile {
    pairs: Vec<PPPair>,
}
#[derive(Deserialize)]
struct PPPair {
    from: String,
    to: String,
    status: String,
    segments: Vec<Vec<i64>>,
}

#[allow(clippy::needless_range_loop)]
fn dp_keep(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    // Douglas-Peucker in raw degrees (tol ~ degrees). Endpoints always kept.
    let n = pts.len();
    if n <= 2 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (ax, ay) = (pts[a][0], pts[a][1]);
        let (bx, by) = (pts[b][0], pts[b][1]);
        let dx = bx - ax;
        let dy = by - ay;
        let len2 = dx * dx + dy * dy;
        let mut worst = 0.0f64;
        let mut worst_i = a;
        for i in (a + 1)..b {
            let (px, py) = (pts[i][0], pts[i][1]);
            let d = if len2 == 0.0 {
                ((px - ax).powi(2) + (py - ay).powi(2)).sqrt()
            } else {
                let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
                let cx = ax + t * dx;
                let cy = ay + t * dy;
                ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
            };
            if d > worst {
                worst = d;
                worst_i = i;
            }
        }
        if worst > tol {
            keep[worst_i] = true;
            stack.push((a, worst_i));
            stack.push((worst_i, b));
        }
    }
    pts.iter()
        .zip(keep.iter())
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

/// Dijkstra over the corridor graph; returns the chain of pair keys and
/// their total drawn length. Virtual (None) edges move the search between
/// same-city stations but contribute no pair and no drawn length.
fn dijkstra_chain(
    adj: &CorridorAdj,
    a: &str,
    b: &str,
    pair_len: &HashMap<(String, String), f64>,
) -> Option<(Vec<(String, String)>, f64)> {
    let mut dist: HashMap<String, f64> = HashMap::from([(a.to_string(), 0.0)]);
    let mut prev: HashMap<String, (String, Option<(String, String)>)> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::new();
    loop {
        let mut best: Option<(String, f64)> = None;
        for (k, v) in dist.iter() {
            if !visited.contains(k) && best.as_ref().is_none_or(|(_, bv)| v < bv) {
                best = Some((k.clone(), *v));
            }
        }
        let (u, du) = best?;
        if u == b {
            break;
        }
        visited.insert(u.clone());
        if let Some(edges) = adj.get(&u) {
            for (v, pk, w) in edges {
                let nd = du + w;
                if nd < *dist.get(v).unwrap_or(&f64::INFINITY) {
                    dist.insert(v.clone(), nd);
                    prev.insert(v.clone(), (u.clone(), pk.clone()));
                }
            }
        }
    }
    if !dist.contains_key(b) {
        return None;
    }
    let mut pair_chain: Vec<(String, String)> = Vec::new();
    let mut cur = b.to_string();
    while cur != a {
        let (p, pk) = prev.get(&cur)?;
        if let Some(k) = pk {
            pair_chain.push(k.clone());
        }
        cur = p.clone();
    }
    if pair_chain.is_empty() || pair_chain.len() > 40 {
        return None;
    }
    pair_chain.reverse();
    let drawn_total: f64 = pair_chain
        .iter()
        .map(|k| pair_len.get(k).copied().unwrap_or(0.0))
        .sum();
    Some((pair_chain, drawn_total))
}

fn hav_km_ll(p: [f64; 2], q: [f64; 2]) -> f64 {
    let dx = (p[0] - q[0]) * 96.0;
    let dy = (p[1] - q[1]) * 111.0;
    (dx * dx + dy * dy).sqrt()
}

fn round_pt(p: [f64; 2], dp: i32) -> [f64; 2] {
    let f = 10f64.powi(dp);
    [(p[0] * f).round() / f, (p[1] * f).round() / f]
}

// ================= atlas types =================
#[derive(serde::Serialize)]
struct AtlasCity {
    zh: String,
    en: String,
    pt: [f64; 2],
}
#[derive(serde::Serialize)]
struct AtlasStation {
    zh: String,
    en: String,
}
#[derive(serde::Serialize)]
struct AtlasTrainRef {
    code: String,
    class: String,
}
#[derive(serde::Serialize)]
struct AtlasSection {
    a: i64,
    b: i64,
    g: String,
}

/// Google polyline encoding (1e5 precision); pts are [lon, lat].
fn polyline_encode(pts: &[[f64; 2]]) -> String {
    let mut out = String::new();
    let mut last = [0i64; 2];
    for p in pts {
        let cur = [(p[1] * 1e5).round() as i64, (p[0] * 1e5).round() as i64];
        for i in 0..2 {
            let mut v = cur[i] - last[i];
            v = if v < 0 { !(v << 1) } else { v << 1 };
            while v >= 0x20 {
                out.push((((0x20 | (v & 0x1f)) + 63) as u8) as char);
                v >>= 5;
            }
            out.push(((v + 63) as u8) as char);
        }
        last = cur;
    }
    out
}

type CorridorAdj = HashMap<String, Vec<(String, Option<(String, String)>, f64)>>;
/// Station-pair key used throughout the pipeline.
type PairKey = (String, String);
/// Routed track paths per station pair: (path id, vertex-id segments).
type PathMap = HashMap<PairKey, (String, Vec<Vec<i64>>)>;

/// Resolve one leg to track node sequences: direct pair geometry, else a
/// corridor chain (cached). None = honest chord.
#[allow(clippy::too_many_arguments)]
fn resolve_leg(
    key: &(String, String),
    path_map: &PathMap,
    adj_pure: &CorridorAdj,
    adj: &CorridorAdj,
    pair_len: &HashMap<(String, String), f64>,
    station_pt: &dyn Fn(&str) -> Option<[f64; 2]>,
    cache: &mut HashMap<(String, String), Option<Vec<Vec<i64>>>>,
) -> Option<Vec<Vec<i64>>> {
    if let Some(v) = cache.get(key) {
        return v.clone();
    }
    let result = (|| {
        if let Some((_, segs)) = path_map.get(key) {
            if segs.iter().any(|s| s.len() >= 2) {
                return Some(segs.clone());
            }
        }
        let (a, b) = (&key.0, &key.1);
        let chord_km = match (station_pt(a), station_pt(b)) {
            (Some(p), Some(q)) => hav_km_ll([p[1], p[0]], [q[1], q[0]]),
            _ => return None,
        };
        for adj_ref in [adj_pure, adj] {
            if let Some((pair_chain, drawn_total)) = dijkstra_chain(adj_ref, a, b, pair_len) {
                if drawn_total > chord_km * 1.6 + 20.0 {
                    continue;
                }
                let mut seqs: Vec<Vec<i64>> = Vec::new();
                for k in pair_chain.iter() {
                    if let Some((_, ss)) = path_map.get(k) {
                        for s in ss {
                            if s.len() >= 2 {
                                seqs.push(s.clone());
                            }
                        }
                    }
                }
                if !seqs.is_empty() {
                    return Some(seqs);
                }
            }
        }
        None
    })();
    cache.insert(key.clone(), result.clone());
    result
}

/// One corridor-classification override from legclass: this train's
/// nonstop leg from->to is drawn via the given waypoint chain instead
/// of the pair's default geometry (see legclass.rs for the rule).
#[derive(Deserialize)]
struct LegOverride {
    #[serde(default)]
    train_no: String,
    code: String,
    from: String,
    to: String,
    via: Vec<String>,
}

/// Override lookup keyed (identity, from, to); identity is the train's
/// internal train_no when the record carries one, else its code — both
/// keys are inserted so lookup succeeds with whichever the train has.
type OverrideMap = HashMap<(String, String, String), Vec<String>>;

fn load_overrides(path: &PathBuf) -> OverrideMap {
    let mut map: OverrideMap = HashMap::new();
    if let Ok(txt) = fs::read_to_string(path) {
        if let Ok(recs) = serde_json::from_str::<Vec<LegOverride>>(&txt) {
            println!(
                "leg overrides loaded: {} from {}",
                recs.len(),
                path.display()
            );
            for r in recs {
                if !r.train_no.is_empty() {
                    map.insert(
                        (r.train_no.clone(), r.from.clone(), r.to.clone()),
                        r.via.clone(),
                    );
                }
                map.insert((r.code.clone(), r.from, r.to), r.via);
            }
        }
    }
    map
}

/// Per-train leg paths from the staging corridor router (env
/// ATLAS_LEG_PATHS): each record names one train's directed leg and a
/// track-path id ("#..."). The id becomes that leg's via token, and its
/// segments and km are served from LEG_PATHS. Unset: no effect at all.
#[derive(Deserialize)]
struct LegPath {
    #[serde(default)]
    train_no: String,
    code: String,
    from: String,
    to: String,
    id: String,
    km: f64,
    segments: Vec<Vec<i64>>,
}

type LegPathMap = HashMap<String, (Vec<Vec<i64>>, f64)>;

static LEG_PATHS: std::sync::OnceLock<LegPathMap> = std::sync::OnceLock::new();

/// Load ATLAS_LEG_PATHS (or default corridor-v3 leg_paths) into the override map and LEG_PATHS.
/// Keyed by train_no; by public code only when train_no is absent
/// (codes are reused across physical trains).
fn load_leg_paths(map: &mut OverrideMap, data_dir: &Path) {
    let mut paths: LegPathMap = HashMap::new();
    let p_path = env::var("ATLAS_LEG_PATHS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("derived/corridor-v3/leg_paths.json"));
    if p_path.exists() {
        let recs: Vec<LegPath> =
            serde_json::from_str(&fs::read_to_string(&p_path).unwrap()).unwrap();
        println!("leg paths loaded: {} from {}", recs.len(), p_path.display());
        for r in recs {
            let key_id = if r.train_no.is_empty() {
                r.code
            } else {
                r.train_no
            };
            map.insert((key_id, r.from, r.to), vec![r.id.clone()]);
            paths.entry(r.id).or_insert((r.segments, r.km));
        }
    }
    LEG_PATHS.set(paths).ok();
}

/// The router path behind a via token, if it is one.
fn leg_path(via: &str) -> Option<&'static (Vec<Vec<i64>>, f64)> {
    if via.starts_with('#') {
        LEG_PATHS.get()?.get(via)
    } else {
        None
    }
}

/// The via chain for train t's directed leg a->b, if an override exists.
fn override_via<'m>(map: &'m OverrideMap, t: &Train, a: &str, b: &str) -> Option<&'m [String]> {
    if !t.train_no.is_empty() {
        if let Some(v) = map.get(&(t.train_no.clone(), a.to_string(), b.to_string())) {
            return Some(v.as_slice());
        }
    }
    map.get(&(t.code.clone(), a.to_string(), b.to_string()))
        .map(|v| v.as_slice())
}

/// Leg key: unordered station pair plus the via chain (in key.0 -> key.1
/// direction, ">"-joined; empty = the pair's default geometry).
fn leg_key3(map: &OverrideMap, t: &Train, a: &str, b: &str) -> (String, String, String) {
    let via = override_via(map, t, a, b);
    if a < b {
        (
            a.to_string(),
            b.to_string(),
            via.map(|v| v.join(">")).unwrap_or_default(),
        )
    } else {
        let mut rev: Vec<String> = via.map(|v| v.to_vec()).unwrap_or_default();
        rev.reverse();
        (b.to_string(), a.to_string(), rev.join(">"))
    }
}

/// Track km for train t's directed leg a->b: the via tiling's summed
/// pair lengths when overridden, else the pair's own length.
fn leg_km(
    map: &OverrideMap,
    pair_len: &HashMap<(String, String), f64>,
    t: &Train,
    a: &str,
    b: &str,
) -> Option<f64> {
    let base = |x: &str, y: &str| -> Option<f64> {
        let key = if x < y {
            (x.to_string(), y.to_string())
        } else {
            (y.to_string(), x.to_string())
        };
        pair_len.get(&key).copied()
    };
    if let Some([one]) = override_via(map, t, a, b) {
        if let Some((_, km)) = leg_path(one) {
            return Some(*km);
        }
    }
    match override_via(map, t, a, b) {
        Some(via) if !via.is_empty() => {
            let mut pts: Vec<&str> = vec![a];
            pts.extend(via.iter().map(|s| s.as_str()));
            pts.push(b);
            let mut total = 0.0;
            for w in pts.windows(2) {
                total += base(w[0], w[1])?;
            }
            Some(total)
        }
        _ => base(a, b),
    }
}

type PairCache = HashMap<(String, String), Option<Vec<Vec<i64>>>>;
type VariantCache = HashMap<(String, String, String), Option<Vec<Vec<i64>>>>;

/// Resolve a leg key (pair + optional via chain) to track segments: a
/// variant leg is the concatenation of its sub-pairs' resolved segment
/// lists. If any sub-pair fails to resolve (e.g. its track geometry is
/// absent from the extract — some are chord pairs even in the base
/// build), the variant falls back to the base pair's own resolution,
/// so an override can never make a leg less resolved than it was
/// without overrides. `stats` counts (variant-resolved, fallback).
#[allow(clippy::too_many_arguments)]
fn resolve_leg3(
    key: &(String, String, String),
    path_map: &PathMap,
    adj_pure: &CorridorAdj,
    adj: &CorridorAdj,
    pair_len: &HashMap<(String, String), f64>,
    station_pt: &dyn Fn(&str) -> Option<[f64; 2]>,
    cache: &mut PairCache,
    vcache: &mut VariantCache,
    stats: &mut (u64, u64),
) -> Option<Vec<Vec<i64>>> {
    if let Some((segs, _)) = leg_path(&key.2) {
        return Some(segs.clone());
    }
    if key.2.is_empty() {
        return resolve_leg(
            &(key.0.clone(), key.1.clone()),
            path_map,
            adj_pure,
            adj,
            pair_len,
            station_pt,
            cache,
        );
    }
    if let Some(v) = vcache.get(key) {
        return v.clone();
    }
    let stitched = (|| {
        let mut pts: Vec<&str> = vec![key.0.as_str()];
        pts.extend(key.2.split('>').filter(|s| !s.is_empty()));
        pts.push(key.1.as_str());
        let mut seqs: Vec<Vec<i64>> = Vec::new();
        for w in pts.windows(2) {
            let sub = (w[0].to_string(), w[1].to_string());
            let r = resolve_leg(&sub, path_map, adj_pure, adj, pair_len, station_pt, cache)?;
            seqs.extend(r);
        }
        Some(seqs)
    })();
    let result = match stitched {
        Some(s) => {
            stats.0 += 1;
            Some(s)
        }
        None => {
            stats.1 += 1;
            resolve_leg(
                &(key.0.clone(), key.1.clone()),
                path_map,
                adj_pure,
                adj,
                pair_len,
                station_pt,
                cache,
            )
        }
    };
    vcache.insert(key.clone(), result.clone());
    result
}

/// Geometry lookup for the section/chord passes: pair keys read the
/// pair cache, variant keys the variant cache (populated during the
/// outbound resolution loop; inbound-only variant legs stay unresolved
/// — the known deferred inbound-resolution behaviour).
fn leg_seqs<'c>(
    key: &(String, String, String),
    cache: &'c PairCache,
    vcache: &'c VariantCache,
) -> Option<&'c Vec<Vec<i64>>> {
    if let Some((segs, _)) = leg_path(&key.2) {
        return Some(segs);
    }
    if key.2.is_empty() {
        cache
            .get(&(key.0.clone(), key.1.clone()))
            .and_then(|o| o.as_ref())
    } else {
        vcache.get(key).and_then(|o| o.as_ref())
    }
}

/// Decode a v2-pack polyline (1e4 precision) into [lon, lat] degrees.
fn decode_poly4(s: &str) -> Vec<[f64; 2]> {
    let bytes = s.as_bytes();
    let (mut i, mut lat, mut lon) = (0usize, 0i64, 0i64);
    let mut pts = Vec::new();
    while i < bytes.len() {
        let mut vals = [0i64; 2];
        for v in vals.iter_mut() {
            let (mut shift, mut acc) = (0u32, 0i64);
            loop {
                let b = (bytes[i] - 63) as i64;
                i += 1;
                acc |= (b & 0x1f) << shift;
                shift += 5;
                if b < 0x20 {
                    break;
                }
            }
            *v = if acc & 1 != 0 { !(acc >> 1) } else { acc >> 1 };
        }
        lat += vals[0];
        lon += vals[1];
        pts.push([lon as f64 / 1e4, lat as f64 / 1e4]);
    }
    pts
}

/// Phase 1-2 checks on a packed v2 build (env AUDIT_PACK_DIR): oriented
/// per-train path continuity outside chord legs, monotone call cutoffs,
/// schedule coverage, and the Chengdu goldens. Returns whether the hard
/// checks pass, plus the counters that goldens.json gates on.
fn audit_pack(dir: &Path) -> (bool, BTreeMap<String, i64>) {
    let load = |n: &str| -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(n)).unwrap()).unwrap()
    };
    let shared = load("atlas-v2-shared.json");
    let out_map = load("atlas-v2-out-map.json");
    let in_map = load("atlas-v2-in-map.json");
    let out_t = load("atlas-v2-out-tables.json");
    let in_t = load("atlas-v2-in-tables.json");
    let sch = load("atlas-v2-schedules.json");
    let arr = |v: &Value| -> Vec<Value> { v.as_array().cloned().unwrap_or_default() };
    let int = |v: &Value| v.as_i64().unwrap();
    let mut ok = true;
    for (name, t) in [("out-tables", &out_t), ("in-tables", &in_t)] {
        let fmt = t.get("fmt").and_then(Value::as_i64);
        println!("AUDIT pack {name} fmt: {fmt:?}");
        ok &= fmt == Some(4);
    }
    let ends = |key: &str| -> Vec<([f64; 2], [f64; 2])> {
        arr(&shared[key])
            .iter()
            .map(|s| {
                let p = decode_poly4(s["g"].as_str().unwrap());
                (p[0], *p.last().unwrap())
            })
            .collect()
    };
    let (out_ends, in_ends) = (ends("sections"), ends("in_sections"));
    let codes: Vec<String> = arr(&shared["train_table"])
        .iter()
        .map(|t| t["code"].as_str().unwrap().to_string())
        .collect();
    let zh: Vec<String> = arr(&out_map["origins"])
        .iter()
        .map(|o| o["zh"].as_str().unwrap().to_string())
        .collect();
    // ---- path continuity: exit of oriented section k-1 -> entry of k ----
    let mut worst: Vec<(f64, String)> = Vec::new();
    let (mut checked, mut gaps, mut chord_rows, mut chord_legs) = (0u64, 0u64, 0u64, 0u64);
    // gaps up to 6 km are station-throat trims (B8, optional Phase 3)
    let mut throat_gaps = 0u64;
    let mut bad_trains: HashSet<(usize, &str, usize)> = HashSet::new();
    let mut sec_cnt_over = 0u64;
    // outbound rows with a > 35 km jump, inside chord legs only / outside
    let (mut jump_in, mut jump_out) = (0i64, 0i64);
    for (label, tables, secs_key, chords_key, rows_key, ends) in [
        (
            "out",
            &out_t,
            "dep_secs",
            "dep_chord_legs",
            "deps",
            &out_ends,
        ),
        ("in", &in_t, "arr_secs", "arr_chord_legs", "arrs", &in_ends),
    ] {
        for (oi, o) in arr(&tables["origins"]).iter().enumerate() {
            let rows = arr(&o[rows_key]);
            let chords = arr(&o[chords_key]);
            for (ri, path) in arr(&o[secs_key]).iter().enumerate() {
                let path: Vec<i64> = arr(path).iter().map(int).collect();
                let mut exempt: HashSet<usize> = HashSet::new();
                let cl = arr(&chords[ri]);
                if !cl.is_empty() {
                    chord_rows += 1;
                }
                for c in cl.iter() {
                    chord_legs += 1;
                    for k in int(&c[1])..=int(&c[2]) {
                        exempt.insert(k as usize);
                    }
                }
                let oriented = |v: i64| -> ([f64; 2], [f64; 2]) {
                    if v >= 0 {
                        ends[v as usize]
                    } else {
                        let (a, b) = ends[!v as usize];
                        (b, a)
                    }
                };
                let (mut j_in, mut j_out) = (false, false);
                for k in 1..path.len() {
                    let gap = hav_km_ll(oriented(path[k - 1]).1, oriented(path[k]).0);
                    if exempt.contains(&k) {
                        j_in |= gap > 35.0;
                        continue;
                    }
                    j_out |= gap > 35.0;
                    checked += 1;
                    if gap > 3.0 {
                        gaps += 1;
                        if gap <= 6.0 {
                            throat_gaps += 1;
                        }
                        bad_trains.insert((oi, label, ri));
                        let code = &codes[int(&rows[ri][0]) as usize];
                        worst.push((
                            gap,
                            format!("{} {label} {code} at {k}/{}", zh[oi], path.len()),
                        ));
                    }
                }
                if label == "out" {
                    jump_out += j_out as i64;
                    jump_in += (j_in && !j_out) as i64;
                }
            }
            // ---- cutoffs: per train, sec_cnt never decreases as calls
            // move away from this city (outbound: later arrival; inbound:
            // later boarding = shorter ride) ----
            let calls_key = if label == "out" { "calls" } else { "in_calls" };
            let mut per: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
            for cell in arr(&o[calls_key]).iter() {
                for r in arr(cell).iter() {
                    let (idx, t1, t2, off) = (int(&r[0]), int(&r[1]), int(&r[2]), int(&r[3]));
                    let cnt = int(&r[if label == "out" { 5 } else { 6 }]);
                    let len = arr(&o[secs_key][idx as usize]).len() as i64;
                    if cnt > len {
                        sec_cnt_over += 1;
                    }
                    let key = if label == "out" {
                        off * 1440 + t1
                    } else {
                        off * 1440 + t2 - t1
                    };
                    per.entry(idx).or_default().push((key, cnt));
                }
            }
            for v in per.values_mut() {
                v.sort();
                if v.windows(2).any(|w| w[1].1 < w[0].1) {
                    worst.push((-1.0, format!("{} {label} non-monotone sec_cnt", zh[oi])));
                }
            }
        }
    }
    let non_mono: Vec<&(f64, String)> = worst.iter().filter(|w| w.0 < 0.0).collect();
    println!(
        "AUDIT pack chord legs: {chord_legs} on {chord_rows} train rows (gaps inside are exempt)"
    );
    println!(
        "AUDIT pack path continuity: {gaps} gaps > 3 km in {checked} joins outside chord legs ({} train rows); {throat_gaps} of them <= 6 km (station throats), {} > 6 km",
        bad_trains.len(),
        gaps - throat_gaps
    );
    let mut gap_list: Vec<&(f64, String)> = worst.iter().filter(|w| w.0 >= 0.0).collect();
    gap_list.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    for (g, what) in gap_list.iter().take(20) {
        println!("   {g:>8.1} km  {what}");
    }
    println!(
        "AUDIT pack sec_cnt: {} trains non-monotone, {sec_cnt_over} cutoffs beyond path length",
        non_mono.len()
    );
    println!("AUDIT pack outbound rows with a > 35 km jump: {jump_out} outside chord legs, {jump_in} only inside");
    ok &= sec_cnt_over == 0;
    // ---- schedules: every row's train has one, consistent with the row ----
    let scheds = arr(&sch["schedules"]);
    let extra = arr(&sch["extra_stations"]).len();
    let n_st = arr(&shared["station_table"]).len() as i64;
    let mut bad_idx = 0u64;
    for s in scheds.iter() {
        for r in arr(s).iter() {
            if !(0..n_st).contains(&int(&r[0])) {
                bad_idx += 1;
            }
        }
    }
    let (mut rows_n, mut missing, mut mismatch) = (0u64, 0u64, 0u64);
    for o in arr(&out_t["origins"]).iter() {
        for d in arr(&o["deps"]).iter() {
            rows_n += 1;
            let s = scheds.get(int(&d[0]) as usize).map(arr).unwrap_or_default();
            if s.is_empty() {
                missing += 1;
                continue;
            }
            // [t, fs, dep, ts, tc, arr, dur, stops, km]: boarding call at fs/dep,
            // `stops` calls after it, ending at ts
            let p = s
                .iter()
                .position(|r| int(&r[0]) == int(&d[1]) && int(&r[2]) == int(&d[2]));
            let fine = p.is_some_and(|p| (s.len() - 1 - p) as i64 == int(&d[7]))
                && int(&s.last().unwrap()[0]) == int(&d[3]);
            if !fine {
                mismatch += 1;
            }
        }
    }
    for o in arr(&in_t["origins"]).iter() {
        for a in arr(&o["arrs"]).iter() {
            rows_n += 1;
            let s = scheds.get(int(&a[0]) as usize).map(arr).unwrap_or_default();
            if s.is_empty() {
                missing += 1;
                continue;
            }
            // [t, fs, fc, dep, ts, arr, dur, stops, km]: first stop fs/dep,
            // arrival here is call index `stops`, at ts/arr
            let k = int(&a[7]) as usize;
            let fine = int(&s[0][0]) == int(&a[1])
                && int(&s[0][2]) == int(&a[3])
                && s.get(k)
                    .is_some_and(|r| int(&r[0]) == int(&a[4]) && int(&r[1]) == int(&a[5]));
            if !fine {
                mismatch += 1;
            }
        }
    }
    println!(
        "AUDIT pack schedules: {} trains, extra_stations {extra}, bad station idx {bad_idx}; {rows_n} dep/arr rows: {missing} without schedule, {mismatch} inconsistent",
        scheds.len()
    );
    ok &= extra == 0 && bad_idx == 0 && missing == 0 && mismatch == 0;
    // ---- station-level stops (dep_stop_pos): one position per schedule
    // stop after boarding, monotone, ending at the path end; and every city
    // call is one of those stops (same arrival minute, same position) ----
    let (mut st_total, mut st_bad, mut st_time_back, mut st_rows_extra) = (0i64, 0i64, 0i64, 0i64);
    let mut call_miss = 0i64;
    for o in arr(&out_t["origins"]).iter() {
        let pos_all = arr(&o["dep_stop_pos"]);
        // per dep row: (arrival minute in the calls' frame, path position)
        let mut stops_of: Vec<Vec<(i64, i64)>> = Vec::new();
        for (di, d) in arr(&o["deps"]).iter().enumerate() {
            let pos: Vec<i64> = arr(&pos_all[di]).iter().map(int).collect();
            let len = arr(&o["dep_secs"][di]).len() as i64;
            let sch: Vec<Vec<i64>> = scheds
                .get(int(&d[0]) as usize)
                .map(arr)
                .unwrap_or_default()
                .iter()
                .map(|r| arr(r).iter().take(4).map(int).collect())
                .collect();
            st_total += pos.len() as i64;
            let b = sch.len() as i64 - 1 - int(&d[7]);
            let fine = b >= 0
                && pos.len() as i64 == int(&d[7])
                && pos.windows(2).all(|w| w[0] <= w[1])
                && pos.last() == Some(&len);
            if !fine {
                st_bad += 1;
                stops_of.push(Vec::new());
                continue;
            }
            // schedule minutes (origin-day frame) -> the calls' frame
            let rb = &sch[b as usize];
            let mut dep_b = rb[3] * 1440 + rb[2];
            if rb[1] >= 0 && rb[2] < rb[1] {
                dep_b += 1440;
            }
            let rel = |day: i64, m: i64| day * 1440 + m - dep_b + int(&d[2]);
            let mut times: Vec<i64> = Vec::new();
            let mut row: Vec<(i64, i64)> = Vec::new();
            for (i, p) in pos.iter().enumerate() {
                let r = &sch[b as usize + 1 + i];
                let a = rel(r[3], r[1]);
                times.push(a);
                if r[2] >= 0 && i + 1 < pos.len() {
                    times.push(rel(r[3] + i64::from(r[2] < r[1]), r[2]));
                }
                row.push((a, *p));
            }
            if times.windows(2).any(|w| w[1] < w[0]) {
                st_time_back += 1;
            }
            stops_of.push(row);
        }
        let mut n_calls: HashMap<usize, usize> = HashMap::new();
        for cell in arr(&o["calls"]).iter() {
            for r in arr(cell).iter() {
                let di = int(&r[0]) as usize;
                *n_calls.entry(di).or_default() += 1;
                let arr_t = int(&r[3]) * 1440 + int(&r[1]);
                if !stops_of[di]
                    .iter()
                    .any(|&(a, p)| a == arr_t && p == int(&r[5]))
                {
                    call_miss += 1;
                }
            }
        }
        for (di, s) in stops_of.iter().enumerate() {
            if s.len() > n_calls.get(&di).copied().unwrap_or(0) {
                st_rows_extra += 1;
            }
        }
    }
    println!(
        "AUDIT pack dep_stop_pos: {st_total} station stops; {st_bad} rows inconsistent (count/order/path end), {st_time_back} with times going back, {call_miss} city calls not matching a stop; {st_rows_extra} dep rows have stations without a city call"
    );
    ok &= st_bad == 0 && call_miss == 0;
    let mut g: BTreeMap<String, i64> = BTreeMap::new();
    g.insert("dep_stops_total".into(), st_total);
    g.insert("dep_rows_with_uncalled_stations".into(), st_rows_extra);
    g.insert("dep_stops_time_regressions".into(), st_time_back);
    let n = |v: &Value| arr(v).len() as i64;
    g.insert("origins".into(), n(&out_map["origins"]));
    g.insert("sections".into(), n(&shared["sections"]));
    g.insert("in_sections".into(), n(&shared["in_sections"]));
    g.insert("schedules_trains".into(), scheds.len() as i64);
    g.insert("chord_leg_rows".into(), chord_legs as i64);
    g.insert("continuity_gaps_le6km".into(), throat_gaps as i64);
    g.insert("continuity_gaps_gt6km".into(), (gaps - throat_gaps) as i64);
    g.insert("dep_rows_jump_gt35km_outside_chords".into(), jump_out);
    g.insert("dep_rows_jump_gt35km_inside_chords".into(), jump_in);
    g.insert("nonmonotone_sec_cnt_trains".into(), non_mono.len() as i64);
    // Chengdu goldens (PIPELINE.md section 7 shape)
    let cities: Vec<String> = arr(&shared["city_table"])
        .iter()
        .map(|c| c["zh"].as_str().unwrap().to_string())
        .collect();
    if let Some(ci) = zh.iter().position(|z| z == "成都") {
        let (om, im) = (&out_map["origins"][ci], &in_map["origins"][ci]);
        let widest = |f: &Value| arr(f).iter().map(|r| int(&r[1])).max().unwrap_or(0);
        let cq = |rows: &Value| -> Vec<i64> {
            arr(rows)
                .iter()
                .find(|r| cities[int(&r[0]) as usize] == "重庆")
                .map(|r| arr(r).iter().map(int).collect())
                .unwrap_or_default()
        };
        let (dq, sq) = (cq(&om["dests"]), cq(&im["srcs"]));
        for (k, v) in [
            ("out", int(&om["outbound"])),
            ("dests", n(&om["dests"])),
            ("widest_out", widest(&om["flows"])),
            ("fully_tracked", int(&om["fully_tracked"])),
            ("chords", n(&om["chords"])),
            ("in", int(&om["inbound"])),
            ("srcs", n(&im["srcs"])),
            ("widest_in", widest(&im["in_flows"])),
            ("cq_out", dq.get(1).copied().unwrap_or(-1)),
            ("cq_out_term", dq.get(3).copied().unwrap_or(-1)),
            ("cq_out_fastest", dq.get(4).copied().unwrap_or(-1)),
            ("cq_in", sq.get(1).copied().unwrap_or(-1)),
            ("cq_in_orig", sq.get(3).copied().unwrap_or(-1)),
            ("cq_in_fastest", sq.get(4).copied().unwrap_or(-1)),
        ] {
            g.insert(format!("chengdu_{k}"), v);
        }
    }
    println!(
        "AUDIT pack hard checks: {}",
        if ok { "PASS" } else { "FAIL" }
    );
    (ok, g)
}

/// Gate the pack counters against goldens.json: {"exact": {k: v}, "max":
/// {k: v}}. An exact counter must match; a max counter must not rise.
/// `--update-goldens` rewrites the file with the current values (keys
/// keep their class; new keys go to "max"). Returns false on a breach.
fn gate_goldens(path: &Path, cur: &BTreeMap<String, i64>, update: bool, partial: bool) -> bool {
    let text = fs::read_to_string(path).ok();
    if text.is_none() && !update {
        println!(
            "AUDIT goldens FAIL: {} not found (create it with --update-goldens)",
            path.display()
        );
        return false;
    }
    let old: Value = text
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "exact": {}, "max": {} }));
    if update {
        let mut out = old.clone();
        for (k, v) in cur {
            let class = if old["exact"].get(k).is_some() {
                "exact"
            } else {
                "max"
            };
            out[class][k] = serde_json::json!(v);
        }
        fs::write(path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
        println!("AUDIT goldens: updated {}", path.display());
        return true;
    }
    let mut ok = true;
    for class in ["exact", "max"] {
        for (k, want) in old[class].as_object().into_iter().flatten() {
            let want = want.as_i64().unwrap();
            if partial && !cur.contains_key(k) {
                println!("AUDIT goldens skipped {k} (not computed with --pack-only)");
                continue;
            }
            let breach = match cur.get(k) {
                None => true,
                Some(&got) => (class == "exact" && got != want) || (class == "max" && got > want),
            };
            if breach {
                ok = false;
                println!(
                    "AUDIT goldens BREACH {class} {k}: golden {want}, now {:?}",
                    cur.get(k)
                );
            } else if cur[k] != want {
                println!(
                    "AUDIT goldens improved {k}: {want} -> {} (rebase with --update-goldens)",
                    cur[k]
                );
            }
        }
    }
    println!("AUDIT goldens gate: {}", if ok { "PASS" } else { "FAIL" });
    ok
}

/// Gate `counters` against `--goldens <path>` (default ./goldens.json);
/// `--update-goldens` rebases instead. `partial`: the legacy counters were
/// not computed (`--pack-only`), so golden keys missing here are skipped.
fn run_goldens_gate(counters: &BTreeMap<String, i64>, partial: bool) -> bool {
    let args: Vec<String> = env::args().collect();
    let goldens = args
        .windows(2)
        .find(|w| w[0] == "--goldens")
        .map(|w| PathBuf::from(&w[1]))
        .unwrap_or_else(|| PathBuf::from("goldens.json"));
    gate_goldens(
        &goldens,
        counters,
        args.iter().any(|a| a == "--update-goldens"),
        partial,
    )
}

fn main() {
    let mut pack: Option<(bool, BTreeMap<String, i64>)> = None;
    if let Ok(dir) = env::var("AUDIT_PACK_DIR") {
        let r = audit_pack(Path::new(&dir));
        if env::args().any(|a| a == "--pack-only") {
            let ok = r.0 & run_goldens_gate(&r.1, true);
            std::process::exit(if ok { 0 } else { 1 });
        }
        pack = Some(r);
    }
    let data_dir = if let Ok(d) = env::var("CRFM_DATA_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("data").exists() {
        PathBuf::from("data")
    } else {
        PathBuf::from("../data")
    };
    let files = if let Ok(d) = env::var("CRFM_OUTPUT_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("output").exists() {
        PathBuf::from("output")
    } else {
        PathBuf::from("../output")
    };
    let _out_path = files.join("china-flow-atlas-data.json");
    let overrides_path = env::var("ATLAS_OVERRIDES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("leg_overrides.json"));
    let mut override_map = load_overrides(&overrides_path);
    load_leg_paths(&mut override_map, &data_dir);
    let override_map = override_map;

    let load = |p: &PathBuf| -> Deliverable {
        serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
    };
    let d1 = load(&files.join("china-rail-timetables-2026-10-21.json"));
    let d2 = load(&files.join("china-rail-intercity-2026-10-28.json"));
    let d1_len = d1.trains.len();
    let mut trains = d1.trains.clone();
    trains.extend(d2.trains.iter().cloned());
    println!("trains: {}", trains.len());

    let city_en: HashMap<String, String> =
        serde_json::from_str(&fs::read_to_string(data_dir.join("city_en.json")).unwrap()).unwrap();
    let en = |c: &str| -> String { city_en.get(c).cloned().unwrap_or_else(|| c.to_string()) };
    let osm: HashMap<String, Vec<[f64; 2]>> =
        serde_json::from_str(&fs::read_to_string(data_dir.join("osm_stations.json")).unwrap())
            .unwrap();
    let mut gtfs_pt: HashMap<String, [f64; 2]> = HashMap::new();
    for line in fs::read_to_string(files.join("gtfs-2026-10-21/stops.txt"))
        .unwrap()
        .lines()
        .skip(1)
    {
        let f: Vec<&str> = line.split(',').collect();
        if f.len() >= 4 {
            if let (Ok(lat), Ok(lon)) = (f[2].parse::<f64>(), f[3].parse::<f64>()) {
                gtfs_pt.insert(clean(f[1]), [lat, lon]);
            }
        }
    }
    let station_pt = |name: &str| -> Option<[f64; 2]> {
        if let Some(p) = gtfs_pt.get(name) {
            return Some(*p);
        }
        let cands = osm.get(name)?;
        let lats: Vec<f64> = cands.iter().map(|c| c[0]).collect();
        let lons: Vec<f64> = cands.iter().map(|c| c[1]).collect();
        let m = [median(&lats), median(&lons)];
        // nearest REAL candidate to the median point — independent lat/lon
        // medians invent phantom points for homonym stations (e.g. 迎宾路).
        cands
            .iter()
            .min_by(|x, y| {
                let dx = (x[0] - m[0]).powi(2) + (x[1] - m[1]).powi(2);
                let dy = (y[0] - m[0]).powi(2) + (y[1] - m[1]).powi(2);
                dx.partial_cmp(&dy).unwrap()
            })
            .copied()
    };

    // ---- pair paths ----
    let mut path_map: PathMap = HashMap::new();
    // ATLAS_PAIR_PATHS (comma-separated files) replaces the production
    // pair geometry. Defaults to canonical double-track paths + base pair geometry.
    let pp_files: Vec<PathBuf> = match env::var("ATLAS_PAIR_PATHS") {
        Ok(v) => v.split(',').map(PathBuf::from).collect(),
        Err(_) => {
            let canon = data_dir.join("derived/corridor-v3/pair_paths_canonical.json");
            let mut list = Vec::new();
            if canon.exists() {
                list.push(canon);
            }
            list.push(data_dir.join("derived/pair_paths.json"));
            list.push(data_dir.join("derived/cs_out/pair_paths.json"));
            list
        }
    };
    for pth in pp_files {
        let pp: PPFile = serde_json::from_str(&fs::read_to_string(&pth).unwrap()).unwrap();
        for p in pp.pairs {
            let (a, b) = (clean(&p.from), clean(&p.to));
            let key = if a < b { (a, b) } else { (b, a) };
            path_map
                .entry(key)
                .or_insert((p.status.clone(), p.segments.clone()));
        }
    }
    println!("pair path entries: {}", path_map.len());

    // ---- needed node coords from china-rail.osm ----
    let mut needed: HashSet<i64> = HashSet::new();
    for (_, segs) in path_map.values() {
        for s in segs {
            for id in s {
                needed.insert(*id);
            }
        }
    }
    // Router (#cv3) leg paths run over nodes outside the pair paths; without
    // their coordinates those stretches carry no flow and become chords.
    for (segs, _) in LEG_PATHS.get().into_iter().flat_map(|m| m.values()) {
        for s in segs {
            needed.extend(s.iter().copied());
        }
    }
    println!("needed nodes: {}", needed.len());
    let osm_path = env::var("CRFM_OSM_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("osm/china-rail.osm"));
    let data = fs::read(&osm_path).unwrap();
    println!("osm bytes: {}", data.len());
    let mut coords: HashMap<i64, [f64; 2]> = HashMap::with_capacity(needed.len());
    {
        let needle = b"<node ";
        let mut i = 0usize;
        let n = data.len();
        while i + 6 < n {
            if &data[i..i + 6] == needle {
                // tag ends at next '>'
                let mut end = i + 6;
                while end < n && data[end] != b'>' {
                    end += 1;
                }
                let tag = &data[i..end];
                let get_f64 = |key: &[u8]| -> Option<f64> {
                    let mut k = 0;
                    while k + key.len() + 2 <= tag.len() {
                        if &tag[k..k + key.len()] == key
                            && tag[k + key.len()] == b'='
                            && tag[k + key.len() + 1] == b'"'
                        {
                            let start = k + key.len() + 2;
                            let len = tag[start..].iter().position(|&b| b == b'"')?;
                            return std::str::from_utf8(&tag[start..start + len])
                                .ok()?
                                .parse()
                                .ok();
                        }
                        k += 1;
                    }
                    None
                };
                if let (Some(idf), Some(lat), Some(lon)) =
                    (get_f64(b"id"), get_f64(b"lat"), get_f64(b"lon"))
                {
                    let id = idf as i64;
                    if needed.contains(&id) {
                        coords.insert(id, [lon, lat]);
                    }
                }
                i = end + 1;
            } else {
                i += 1;
            }
        }
    }
    println!("coords resolved: {}", coords.len());

    let seg_coords = |ids: &[i64]| -> Vec<[f64; 2]> {
        ids.iter()
            .filter_map(|id| coords.get(id).copied())
            .collect()
    };

    // ---- precompute per-train names/cities ----
    let train_names: Vec<Vec<String>> = trains
        .iter()
        .map(|t| t.stops.iter().map(|s| clean(&s.name)).collect())
        .collect();
    let train_cities: Vec<Vec<String>> = train_names
        .iter()
        .map(|ns| ns.iter().map(|n| city_of(n)).collect())
        .collect();

    // ---- rank cities by outbound trains ----
    let mut outbound_count: HashMap<String, u64> = HashMap::new();
    for cities in train_cities.iter() {
        let mut seen: HashSet<&str> = HashSet::new();
        for (i, c) in cities.iter().enumerate() {
            if i + 1 < cities.len() && seen.insert(c.as_str()) {
                *outbound_count.entry(c.clone()).or_insert(0) += 1;
            }
        }
    }
    let mut ranked: Vec<(String, u64)> = outbound_count.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let lhasa_entry = ranked.iter().find(|(c, _)| c == "拉萨").cloned();
    let hk_entry = ranked.iter().find(|(c, _)| c == "香港").cloned();
    let top_n = 100usize;
    let mut selected: Vec<String> = ranked.iter().take(top_n).map(|(c, _)| c.clone()).collect();
    if !selected.contains(&"拉萨".to_string()) {
        if let Some((_, n)) = lhasa_entry {
            println!(
                "Adding Lhasa (拉萨) as a special featured origin city ({} outbound trains)",
                n
            );
            selected.push("拉萨".to_string());
        }
    }
    if !selected.contains(&"香港".to_string()) {
        if let Some((_, n)) = hk_entry {
            println!(
                "Adding Hong Kong (香港) as a special featured origin city ({} outbound trains)",
                n
            );
            selected.push("香港".to_string());
        }
    }
    println!("TOP {} CITIES BY OUTBOUND TRAINS:", top_n);
    for (i, (c, n)) in ranked.iter().take(top_n).enumerate() {
        println!("  {:>2}. {} {} - {}", i + 1, c, en(c), n);
    }

    // ---- global station stop counts per city -> principal points ----
    let mut city_stations: HashMap<String, HashMap<String, (u64, usize)>> = HashMap::new();
    let mut cs_counter = 0usize;
    for (ti, _) in trains.iter().enumerate() {
        for (i, nm) in train_names[ti].iter().enumerate() {
            let e = city_stations
                .entry(train_cities[ti][i].clone())
                .or_default()
                .entry(nm.clone())
                .or_insert_with(|| {
                    let v = cs_counter;
                    cs_counter += 1;
                    (0, v)
                });
            e.0 += 1;
        }
    }
    let mut city_pt: HashMap<String, [f64; 2]> = HashMap::new(); // [lat, lon]
    for (cty, sts) in city_stations.iter() {
        let mut ordered: Vec<(&String, &(u64, usize))> = sts.iter().collect();
        ordered.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.1 .1.cmp(&b.1 .1)));
        for (nm, _) in ordered {
            if let Some(p) = station_pt(nm) {
                city_pt.insert(cty.clone(), p);
                break;
            }
        }
    }

    // ---- corridor graph (shared by all cities) ----
    let pair_len: HashMap<(String, String), f64> = path_map
        .iter()
        .filter(|(_, (_, segs))| segs.iter().any(|s| s.len() >= 2))
        .map(|(k, (_, segs))| {
            let l: f64 = segs
                .iter()
                .map(|s| {
                    let c = seg_coords(s);
                    c.windows(2).map(|w| hav_km_ll(w[0], w[1])).sum::<f64>()
                })
                .sum();
            (k.clone(), l)
        })
        .collect();
    let mut adj_pure: CorridorAdj = HashMap::new();
    let mut adj: CorridorAdj = HashMap::new();
    for (k, l) in pair_len.iter() {
        adj_pure
            .entry(k.0.clone())
            .or_default()
            .push((k.1.clone(), Some(k.clone()), *l));
        adj_pure
            .entry(k.1.clone())
            .or_default()
            .push((k.0.clone(), Some(k.clone()), *l));
        adj.entry(k.0.clone())
            .or_default()
            .push((k.1.clone(), Some(k.clone()), *l));
        adj.entry(k.1.clone())
            .or_default()
            .push((k.0.clone(), Some(k.clone()), *l));
    }
    {
        let mut all_stations: HashSet<String> = HashSet::new();
        for (a, b) in path_map.keys() {
            all_stations.insert(a.clone());
            all_stations.insert(b.clone());
        }
        let mut by_city: HashMap<String, Vec<String>> = HashMap::new();
        for s in all_stations.iter() {
            by_city.entry(city_of(s)).or_default().push(s.clone());
        }
        for sts in by_city.values() {
            if sts.len() < 2 || sts.len() > 12 {
                continue;
            }
            for i in 0..sts.len() {
                for j in (i + 1)..sts.len() {
                    if let (Some(p), Some(q)) = (station_pt(&sts[i]), station_pt(&sts[j])) {
                        let w = hav_km_ll([p[1], p[0]], [q[1], q[0]]) * 2.0 + 2.0;
                        if w > 60.0 {
                            continue;
                        }
                        adj.entry(sts[i].clone())
                            .or_default()
                            .push((sts[j].clone(), None, w));
                        adj.entry(sts[j].clone())
                            .or_default()
                            .push((sts[i].clone(), None, w));
                    }
                }
            }
        }
    }
    let mut leg_cache: HashMap<(String, String), Option<Vec<Vec<i64>>>> = HashMap::new();
    let mut variant_cache: VariantCache = HashMap::new();
    let mut variant_stats: (u64, u64) = (0, 0);

    // ---- interning tables (filled during assembly) ----
    let _city_table: Vec<AtlasCity> = Vec::new();
    let _city_idx: HashMap<String, i64> = HashMap::new();
    let _station_table: Vec<AtlasStation> = Vec::new();
    let _station_idx: HashMap<String, i64> = HashMap::new();
    let _train_table: Vec<AtlasTrainRef> = Vec::new();
    let _train_idx: HashMap<(String, String), usize> = HashMap::new();

    // ---- per-city work ----
    // Mirrors atlas.rs's data model; the audit reads only the flow fields.
    #[allow(dead_code)]
    struct DepRaw {
        code: String,
        class: String,
        from_station: String,
        depart: String,
        to_station: String,
        to_city: String,
        arrive: String,
        dur: Option<i64>,
        stops_after: u64,
        set: u8,
    }
    #[allow(dead_code)]
    struct CityWork {
        zh: String,
        outbound: u64,
        fully_tracked: u64,
        legs: Vec<((String, String, String), u64)>,
        dests: Vec<(String, DestStats)>,
        deps: Vec<DepRaw>,
        home_pt: [f64; 2],
        train_leg_keys: Vec<Vec<(String, String, String)>>,
    }
    let mut works: Vec<CityWork> = Vec::new();
    let mut throat_stations: HashSet<String> = HashSet::new();
    for home_city in selected.iter() {
        let mut out_stats: HashMap<String, DestStats> = HashMap::new();
        let mut counter = 0usize;
        let mut leg_count: HashMap<(String, String, String), u64> = HashMap::new();
        let mut deps: Vec<DepRaw> = Vec::new();
        let mut outbound = 0u64;
        let mut train_legs: Vec<Vec<(String, String, String)>> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let cd_idx = match cities.iter().position(|c| c == home_city) {
                Some(i) => i,
                None => continue,
            };
            if cd_idx + 1 >= cities.len() {
                continue;
            }
            outbound += 1;
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            let final_city = cities.last().unwrap().clone();
            deps.push(DepRaw {
                code: t.code.clone(),
                class: t.train_class.clone(),
                from_station: names[cd_idx].clone(),
                depart: t.stops[cd_idx].depart.clone(),
                to_station: names.last().unwrap().clone(),
                to_city: final_city.clone(),
                arrive: t.stops.last().unwrap().arrive.clone(),
                dur: travel_time(&t.stops, cd_idx, t.stops.len() - 1),
                stops_after: (t.stops.len() - 1 - cd_idx) as u64,
                set: if ti < d1_len { 0 } else { 1 },
            });
            let mut seen_dest: HashSet<String> = HashSet::new();
            let mut cum_km = 0f64;
            let mut cum_ok = true;
            let mut last_k = cd_idx;
            // j walks cities/names/stops in lockstep; the index is the join.
            #[allow(clippy::needless_range_loop)]
            for j in (cd_idx + 1)..cities.len() {
                // extend cumulative track distance from stop last_k to stop j
                while last_k < j {
                    let (a, b) = (names[last_k].clone(), names[last_k + 1].clone());
                    if a != b {
                        match leg_km(&override_map, &pair_len, t, &a, &b) {
                            Some(l) => cum_km += l,
                            None => cum_ok = false,
                        }
                    }
                    last_k += 1;
                }
                if &cities[j] == home_city || !seen_dest.insert(cities[j].clone()) {
                    continue;
                }
                let dest = cities[j].clone();
                let e = out_stats.entry(dest.clone()).or_insert_with(|| {
                    let v = counter;
                    counter += 1;
                    DestStats {
                        first: v,
                        ..Default::default()
                    }
                });
                e.total += 1;
                if is_fast {
                    e.fast += 1;
                }
                if final_city == dest {
                    e.terminating += 1;
                }
                if let Some(tt) = travel_time(&t.stops, cd_idx, j) {
                    if tt > 0 && tt < 6000 {
                        e.times.push(tt);
                    }
                }
                if cum_ok && cum_km > 0.0 {
                    e.rail.push(cum_km);
                }
            }
            let mut legs: Vec<(String, String, String)> = Vec::new();
            for j in cd_idx..(names.len() - 1) {
                let (a, b) = (names[j].clone(), names[j + 1].clone());
                if a == b {
                    continue;
                }
                let key = leg_key3(&override_map, t, &a, &b);
                *leg_count.entry(key.clone()).or_insert(0) += 1;
                legs.push(key);
            }
            train_legs.push(legs);
        }
        let mut legs_vec: Vec<((String, String, String), u64)> = Vec::new();
        let mut resolved_flags: HashMap<(String, String, String), bool> = HashMap::new();
        for (k, n) in leg_count.iter() {
            let r = resolve_leg3(
                k,
                &path_map,
                &adj_pure,
                &adj,
                &pair_len,
                &station_pt,
                &mut leg_cache,
                &mut variant_cache,
                &mut variant_stats,
            );
            resolved_flags.insert(k.clone(), r.is_some());
            legs_vec.push((k.clone(), *n));
            throat_stations.insert(k.0.clone());
            throat_stations.insert(k.1.clone());
        }
        let mut fully = 0u64;
        for legs in train_legs.iter() {
            if legs
                .iter()
                .all(|k| resolved_flags.get(k).copied().unwrap_or(false))
            {
                fully += 1;
            }
        }
        deps.sort_by(|x, y| x.depart.cmp(&y.depart).then(x.code.cmp(&y.code)));
        let mut dests: Vec<(String, DestStats)> = out_stats.into_iter().collect();
        dests.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.1.first.cmp(&b.1.first)));
        let hp = city_pt.get(home_city).copied().unwrap_or([30.63, 104.13]);
        println!(
            "{}: outbound {} dests {} legs {} fully {}",
            home_city,
            outbound,
            dests.len(),
            legs_vec.len(),
            fully
        );
        works.push(CityWork {
            zh: home_city.clone(),
            outbound,
            fully_tracked: fully,
            legs: legs_vec,
            dests,
            deps,
            home_pt: [hp[1], hp[0]],
            train_leg_keys: train_legs,
        });
    }

    // ---- global atomic sections over the union of all selected cities ----
    let mut station_grid: HashMap<(i32, i32), Vec<[f64; 2]>> = HashMap::new();
    for nm in throat_stations.iter() {
        if let Some(p) = station_pt(nm) {
            let ll = [p[1], p[0]];
            station_grid
                .entry(((ll[0] * 50.0).floor() as i32, (ll[1] * 50.0).floor() as i32))
                .or_default()
                .push(ll);
        }
    }
    let near_station = |pt: &[f64; 2]| -> bool {
        let gx = (pt[0] * 50.0).floor() as i32;
        let gy = (pt[1] * 50.0).floor() as i32;
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(cell) = station_grid.get(&(gx + dx, gy + dy)) {
                    for c in cell {
                        if hav_km_ll(*pt, *c) < 1.3 {
                            return true;
                        }
                    }
                }
            }
        }
        false
    };
    // atomic edge -> per-city DISTINCT train counts (dedup, as production)
    let mut edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    for (ci, w) in works.iter().enumerate() {
        for legs in w.train_leg_keys.iter() {
            let mut eset: HashSet<(i64, i64)> = HashSet::new();
            for key in legs.iter() {
                let seqs = match leg_seqs(key, &leg_cache, &variant_cache) {
                    Some(s) => s,
                    _ => continue,
                };
                for s in seqs.iter() {
                    for win in s.windows(2) {
                        let (c1, c2) = match (coords.get(&win[0]), coords.get(&win[1])) {
                            (Some(x), Some(y)) => (*x, *y),
                            _ => continue,
                        };
                        let mid = [(c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0];
                        if near_station(&mid) {
                            continue;
                        }
                        eset.insert(if win[0] < win[1] {
                            (win[0], win[1])
                        } else {
                            (win[1], win[0])
                        });
                    }
                }
            }
            for e in eset {
                *edge_counts.entry(e).or_default().entry(ci).or_insert(0) += 1;
            }
        }
    }
    println!("union atomic edges: {}", edge_counts.len());
    // intern count signatures: a global section has constant per-city counts
    let mut sig_ids: HashMap<Vec<(usize, u64)>, u32> = HashMap::new();
    let mut sig_list: Vec<Vec<(usize, u64)>> = Vec::new();
    let mut edge_sig: HashMap<(i64, i64), u32> = HashMap::new();
    for (e, m) in edge_counts.iter() {
        let mut sig: Vec<(usize, u64)> = m.iter().map(|(c, n)| (*c, *n)).collect();
        sig.sort();
        let id = match sig_ids.get(&sig) {
            Some(id) => *id,
            None => {
                let id = sig_list.len() as u32;
                sig_list.push(sig.clone());
                sig_ids.insert(sig, id);
                id
            }
        };
        edge_sig.insert(*e, id);
    }
    println!("distinct signatures: {}", sig_list.len());
    let mut nadj: HashMap<i64, Vec<(i64, u32)>> = HashMap::new();
    for (e, sid) in edge_sig.iter() {
        nadj.entry(e.0).or_default().push((e.1, *sid));
        nadj.entry(e.1).or_default().push((e.0, *sid));
    }
    let ekey = |u: i64, v: i64| if u < v { (u, v) } else { (v, u) };
    let mut used: HashSet<(i64, i64)> = HashSet::new();
    let mut section_chains: Vec<(u32, Vec<i64>)> = Vec::new();
    for (e, sid) in edge_sig.iter() {
        if used.contains(e) {
            continue;
        }
        let sid = *sid;
        let mut chain: Vec<i64> = vec![e.0, e.1];
        used.insert(*e);
        loop {
            let cur = *chain.last().unwrap();
            let prev = chain[chain.len() - 2];
            let cands: Vec<i64> = nadj
                .get(&cur)
                .map(|v| {
                    v.iter()
                        .filter(|(n, s)| *n != prev && *s == sid)
                        .map(|(n, _)| *n)
                        .collect()
                })
                .unwrap_or_default();
            if cands.len() == 1 && !used.contains(&ekey(cur, cands[0])) {
                used.insert(ekey(cur, cands[0]));
                chain.push(cands[0]);
            } else {
                break;
            }
        }
        loop {
            let cur = chain[0];
            let next = chain[1];
            let cands: Vec<i64> = nadj
                .get(&cur)
                .map(|v| {
                    v.iter()
                        .filter(|(n, s)| *n != next && *s == sid)
                        .map(|(n, _)| *n)
                        .collect()
                })
                .unwrap_or_default();
            if cands.len() == 1 && !used.contains(&ekey(cur, cands[0])) {
                used.insert(ekey(cur, cands[0]));
                chain.insert(0, cands[0]);
            } else {
                break;
            }
        }
        section_chains.push((sid, chain));
    }
    // section endpoint station names (nearest real station point)
    let mut station_pts_all: HashMap<String, [f64; 2]> = HashMap::new();
    for (a, b) in path_map.keys() {
        for s in [a, b] {
            if let Some(p) = station_pt(s) {
                station_pts_all.insert(s.clone(), [p[1], p[0]]);
            }
        }
    }
    let nearest_station = |pt: [f64; 2]| -> String {
        let mut best: Option<(&String, f64)> = None;
        for (nm, sp) in station_pts_all.iter() {
            let d = hav_km_ll(pt, *sp);
            if d < 5.0 && best.is_none_or(|(_, bd)| d < bd) {
                best = Some((nm, d));
            }
        }
        best.map(|(nm, _)| nm.clone()).unwrap_or_default()
    };
    let mut sections: Vec<AtlasSection> = Vec::new();
    let mut flows_per_city: Vec<Vec<[usize; 2]>> = vec![Vec::new(); works.len()];
    let mut total_sec_pts = 0usize;
    for (sid, chain) in section_chains.iter() {
        let raw: Vec<[f64; 2]> = chain
            .iter()
            .filter_map(|id| coords.get(id).copied())
            .collect();
        if raw.len() < 2 {
            continue;
        }
        let simp = dp_keep(&raw, 0.00035);
        let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 4)).collect();
        if simp.len() < 2 {
            continue;
        }
        total_sec_pts += simp.len();
        let sec_idx = sections.len();
        // Endpoint station names are an atlas concern; the audit leaves
        // them unset and checks counts and geometry instead.
        sections.push(AtlasSection {
            a: -1,
            b: -1,
            g: polyline_encode(&simp),
        });
        for (ci, n) in sig_list[*sid as usize].iter() {
            flows_per_city[*ci].push([sec_idx, *n as usize]);
        }
    }
    for f in flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    println!("sections: {} points: {}", sections.len(), total_sec_pts);

    // ================= AUDIT (standalone bin) =================
    // chain-level flows from signatures
    let n_chains = section_chains.len();
    // dropped chains: geometry missing -> counts lost in JSON output
    let mut dropped_flow = 0u64;
    let mut dropped_chains = 0usize;
    for (sid, chain) in section_chains.iter() {
        let raw_n = chain.iter().filter(|id| coords.contains_key(id)).count();
        if raw_n < 2 {
            dropped_chains += 1;
            for (_, n) in sig_list[*sid as usize].iter() {
                dropped_flow += n;
            }
        }
    }
    println!(
        "AUDIT dropped chains (no geometry): {} (flow lost {})",
        dropped_chains, dropped_flow
    );
    // edge -> chain
    let mut edge_to_chain: HashMap<(i64, i64), usize> = HashMap::new();
    for (ci2, (_, chain)) in section_chains.iter().enumerate() {
        for w in chain.windows(2) {
            let e = if w[0] < w[1] {
                (w[0], w[1])
            } else {
                (w[1], w[0])
            };
            edge_to_chain.insert(e, ci2);
        }
    }
    // per-train dedup recount vs signature flows
    let mut total_diff_sections = 0usize;
    let mut worst: Vec<(String, i64, usize)> = Vec::new();
    for (ci, w) in works.iter().enumerate() {
        // signature flows per chain
        let mut sig_flow: HashMap<usize, u64> = HashMap::new();
        for (ch, (sid, _)) in section_chains.iter().enumerate() {
            for (c2, n) in sig_list[*sid as usize].iter() {
                if *c2 == ci {
                    sig_flow.insert(ch, *n);
                }
            }
        }
        // dedup recount: per train, set of chains its edges touch
        let mut recount: HashMap<usize, u64> = HashMap::new();
        for legs in w.train_leg_keys.iter() {
            let mut hit: HashSet<usize> = HashSet::new();
            for key in legs.iter() {
                if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                    for s in seqs.iter() {
                        for win in s.windows(2) {
                            let (c1, c2) = match (coords.get(&win[0]), coords.get(&win[1])) {
                                (Some(x), Some(y)) => (*x, *y),
                                _ => continue,
                            };
                            let mid = [(c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0];
                            if near_station(&mid) {
                                continue;
                            }
                            let e = if win[0] < win[1] {
                                (win[0], win[1])
                            } else {
                                (win[1], win[0])
                            };
                            if let Some(ch) = edge_to_chain.get(&e) {
                                hit.insert(*ch);
                            }
                        }
                    }
                }
            }
            for ch in hit {
                *recount.entry(ch).or_insert(0) += 1;
            }
        }
        let mut diffs = 0usize;
        let mut maxd = 0i64;
        let keys: HashSet<usize> = sig_flow.keys().chain(recount.keys()).copied().collect();
        for ch in keys {
            let a = sig_flow.get(&ch).copied().unwrap_or(0) as i64;
            let b = recount.get(&ch).copied().unwrap_or(0) as i64;
            if a != b {
                diffs += 1;
                if (a - b).abs() > maxd {
                    maxd = (a - b).abs();
                }
            }
        }
        total_diff_sections += diffs;
        worst.push((w.zh.clone(), maxd, diffs));
        println!(
            "AUDIT dedup {}: chains differing {}, max |diff| {}",
            w.zh, diffs, maxd
        );
    }
    println!(
        "AUDIT dedup total differing chains: {}",
        total_diff_sections
    );
    // decompose the single worst chain overall
    {
        let mut best: Option<(usize, usize, i64, u64, u64)> = None; // ci, chain, diff, sig, recount
        for (ci, w) in works.iter().enumerate() {
            let mut sig_flow: HashMap<usize, u64> = HashMap::new();
            for (ch, (sid, _)) in section_chains.iter().enumerate() {
                for (c2, n) in sig_list[*sid as usize].iter() {
                    if *c2 == ci {
                        sig_flow.insert(ch, *n);
                    }
                }
            }
            let mut recount: HashMap<usize, u64> = HashMap::new();
            let mut touches: HashMap<usize, HashMap<usize, u32>> = HashMap::new(); // chain -> train idx -> legs touching
            for (ti2, legs) in w.train_leg_keys.iter().enumerate() {
                let mut hit: HashMap<usize, u32> = HashMap::new();
                for key in legs.iter() {
                    if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                        for s2 in seqs.iter() {
                            for win in s2.windows(2) {
                                let (c1, c2b) = match (coords.get(&win[0]), coords.get(&win[1])) {
                                    (Some(x), Some(y)) => (*x, *y),
                                    _ => continue,
                                };
                                let mid = [(c1[0] + c2b[0]) / 2.0, (c1[1] + c2b[1]) / 2.0];
                                if near_station(&mid) {
                                    continue;
                                }
                                let e = if win[0] < win[1] {
                                    (win[0], win[1])
                                } else {
                                    (win[1], win[0])
                                };
                                if let Some(ch) = edge_to_chain.get(&e) {
                                    *hit.entry(*ch).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                }
                for ch in hit.keys() {
                    *recount.entry(*ch).or_insert(0) += 1;
                }
                for (ch, cnt) in hit.iter() {
                    touches.entry(*ch).or_default().insert(ti2, *cnt);
                }
            }
            let keys: HashSet<usize> = sig_flow.keys().chain(recount.keys()).copied().collect();
            for ch in keys {
                let a = sig_flow.get(&ch).copied().unwrap_or(0);
                let b = recount.get(&ch).copied().unwrap_or(0);
                let df = (a as i64 - b as i64).abs();
                if best.is_none_or(|(_, _, bd, _, _)| df > bd) {
                    best = Some((ci, ch, df, a, b));
                }
            }
            if ci == 4 {
                // Changsha deep-dive printed below via best if it is the worst
            }
            let _ = touches;
        }
        if let Some((ci, ch, df, a, b)) = best {
            let w = &works[ci];
            let chain = &section_chains[ch].1;
            let p0 = coords.get(&chain[0]).copied().unwrap_or([0.0, 0.0]);
            let p1 = coords
                .get(chain.last().unwrap())
                .copied()
                .unwrap_or([0.0, 0.0]);
            println!("WORST chain: origin {} chain {} sig {} recount {} diff {} ends near {} .. {} nodes {}",
                w.zh, ch, a, b, df, nearest_station(p0), nearest_station(p1), chain.len());
            // which legs contribute, and how many of their trains touch the chain in >1 leg
            let chain_edges: HashSet<(i64, i64)> = chain
                .windows(2)
                .map(|w2| {
                    if w2[0] < w2[1] {
                        (w2[0], w2[1])
                    } else {
                        (w2[1], w2[0])
                    }
                })
                .collect();
            let mut legstat: HashMap<(String, String, String), (u64, u64)> = HashMap::new(); // leg -> (trains using leg, trains whose THIS leg touches chain)
            for legs in w.train_leg_keys.iter() {
                let mut counted: HashSet<(String, String, String)> = HashSet::new();
                for key in legs.iter() {
                    if counted.contains(key) {
                        continue;
                    }
                    let touch = if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                        seqs.iter().any(|s2| {
                            s2.windows(2).any(|win| {
                                let e = if win[0] < win[1] {
                                    (win[0], win[1])
                                } else {
                                    (win[1], win[0])
                                };
                                chain_edges.contains(&e)
                            })
                        })
                    } else {
                        false
                    };
                    let e = legstat.entry(key.clone()).or_insert((0, 0));
                    e.0 += 1;
                    if touch {
                        e.1 += 1;
                    }
                    counted.insert(key.clone());
                }
            }
            let mut rows: Vec<_> = legstat.into_iter().filter(|(_, (_, t))| *t > 0).collect();
            rows.sort_by_key(|x| std::cmp::Reverse(x.1 .1));
            for (k, (tot, t)) in rows.iter().take(10) {
                println!(
                    "   leg {} -> {} trains-on-leg {} touching-chain {}",
                    k.0, k.1, tot, t
                );
            }
        }
    }
    // junction balance: a section may not carry more than all other incident
    // sections at a junction plus trains terminating at that junction's city
    let mut node_chains: HashMap<i64, Vec<usize>> = HashMap::new();
    for (ch, (_, chain)) in section_chains.iter().enumerate() {
        node_chains.entry(chain[0]).or_default().push(ch);
        node_chains
            .entry(*chain.last().unwrap())
            .or_default()
            .push(ch);
    }
    let mut flags = 0usize;
    for (ci, w) in works.iter().enumerate() {
        let term_by_city: HashMap<String, u64> = w
            .dests
            .iter()
            .map(|(zh, s)| (zh.clone(), s.terminating))
            .collect();
        let mut sig_flow: HashMap<usize, u64> = HashMap::new();
        for (ch, (sid, _)) in section_chains.iter().enumerate() {
            for (c2, n) in sig_list[*sid as usize].iter() {
                if *c2 == ci {
                    sig_flow.insert(ch, *n);
                }
            }
        }
        for (node, chs) in node_chains.iter() {
            if chs.len() < 2 {
                continue;
            }
            let counts: Vec<u64> = chs
                .iter()
                .map(|ch| sig_flow.get(ch).copied().unwrap_or(0))
                .collect();
            let m = *counts.iter().max().unwrap_or(&0);
            if m == 0 {
                continue;
            }
            let s: u64 = counts.iter().sum::<u64>() - m;
            // termination credit: city of nearest station to this junction
            let credit = match coords.get(node) {
                Some(pt) => {
                    let nm = nearest_station(*pt);
                    if nm.is_empty() {
                        0
                    } else {
                        let cty = city_of(&nm);
                        if cty == w.zh {
                            w.outbound
                        } else {
                            term_by_city.get(&cty).copied().unwrap_or(0)
                        }
                    }
                }
                None => 0,
            };
            if m > s + credit + 2 {
                flags += 1;
                if flags <= 15 {
                    println!(
                        "AUDIT junction flag {}: node {} max {} others {} credit {}",
                        w.zh, node, m, s, credit
                    );
                }
            }
        }
    }
    println!(
        "AUDIT variant legs: {} resolved via override tiling, {} fell back to base pair geometry",
        variant_stats.0, variant_stats.1
    );
    println!("AUDIT junction flags total: {}", flags);
    println!("AUDIT chains total: {}", n_chains);
    if let Some((ok, mut counters)) = pack {
        counters.insert("dropped_chains".into(), dropped_chains as i64);
        counters.insert("flow_lost".into(), dropped_flow as i64);
        let ok = ok & run_goldens_gate(&counters, false);
        std::process::exit(if ok { 0 } else { 1 });
    }
}
