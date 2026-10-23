use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

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
    // Part of the timetable file schema; not read by this builder.
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
    calls: Vec<CallRaw>,
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

/// English for a station name: curated specials, else base place EN from the
/// city gazetteer plus a suffix word (East/South/West/North/Airport).
fn station_en(name: &str, city_en: &HashMap<String, String>) -> String {
    let specials: &[(&str, &str)] = &[
        ("北京南", "Beijing South"),
        ("北京西", "Beijing West"),
        ("北京丰台", "Beijing Fengtai"),
        ("北京", "Beijing"),
        ("上海虹桥", "Shanghai Hongqiao"),
        ("上海南", "Shanghai South"),
        ("上海", "Shanghai"),
        ("广州南", "Guangzhou South"),
        ("广州东", "Guangzhou East"),
        ("广州", "Guangzhou"),
        ("深圳北", "Shenzhen North"),
        ("深圳", "Shenzhen"),
        ("香港西九龙", "Hong Kong West Kowloon"),
        ("成都东", "Chengdu East"),
        ("成都南", "Chengdu South"),
        ("成都西", "Chengdu West"),
        ("重庆北", "Chongqing North"),
        ("重庆西", "Chongqing West"),
        ("重庆东", "Chongqing East"),
        ("重庆", "Chongqing"),
        ("西安北", "Xi'an North"),
        ("西安", "Xi'an"),
        ("武汉", "Wuhan"),
        ("汉口", "Hankou"),
        ("武昌", "Wuchang"),
        ("杭州东", "Hangzhou East"),
        ("南京南", "Nanjing South"),
        ("长沙南", "Changsha South"),
        ("昆明南", "Kunming South"),
        ("贵阳北", "Guiyang North"),
        ("贵阳东", "Guiyang East"),
        ("兰州西", "Lanzhou West"),
        ("拉萨", "Lhasa"),
        ("乌鲁木齐", "Urumqi"),
        ("乌鲁木齐南", "Urumqi South"),
        ("福田", "Futian"),
        ("沙坪坝", "Shapingba"),
        ("天府机场", "Tianfu Airport"),
        ("双流机场", "Shuangliu Airport"),
        ("江北机场", "Jiangbei Airport"),
        ("天津", "Tianjin"),
        ("天津西", "Tianjin West"),
    ];
    for (k, v) in specials {
        if name == *k {
            return v.to_string();
        }
    }
    let base_en = |b: &str| -> Option<String> {
        city_en
            .get(b)
            .cloned()
            .or_else(|| city_en.get(&city_of(b)).cloned())
    };
    if let Some(b) = name.strip_suffix("机场") {
        if let Some(e) = base_en(b) {
            return format!("{} Airport", e);
        }
    }
    for (suf, word) in [
        ("东", "East"),
        ("南", "South"),
        ("西", "West"),
        ("北", "North"),
    ] {
        if let Some(b) = name.strip_suffix(suf) {
            if let Some(e) = base_en(b) {
                return format!("{} {}", e, word);
            }
        }
    }
    if let Some(b) = name.strip_suffix("站") {
        if let Some(e) = base_en(b) {
            return e;
        }
    }
    base_en(name).unwrap_or_default()
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
fn is_zero(v: &u8) -> bool {
    *v == 0
}

fn class_idx(c: &str) -> usize {
    match c {
        "G" => 0,
        "D" => 1,
        "C" => 2,
        "S" => 3,
        "Z" => 4,
        "T" => 5,
        "K" => 6,
        _ => 7,
    }
}

fn pack_flow_row(sec_idx: usize, n: usize, cls_counts: &[u32; 8]) -> Vec<usize> {
    let mut row = Vec::with_capacity(10);
    row.push(sec_idx);
    row.push(n);
    let mut last_nz = 0usize;
    for (i, &c) in cls_counts.iter().enumerate() {
        if c > 0 {
            last_nz = i + 1;
        }
    }
    for &c in &cls_counts[..last_nz] {
        row.push(c as usize);
    }
    row
}

#[derive(serde::Serialize)]
struct AtlasSection {
    a: i64,
    b: i64,
    g: String,
    #[serde(skip_serializing_if = "is_zero")]
    h: u8,
}
#[derive(serde::Serialize)]
struct AtlasChord {
    a: i64,
    b: i64,
    n: u64,
    g: String,
}
/// One call row in an origin's calls list: (dep row idx, arr, dep, day off, terminates, sec_cnt).
type CallList = Vec<(usize, String, String, i64, u8, usize)>;
/// One call row in a destination's inbound calls list:
/// (arr row idx, board time, arrival time, day off, started-here, board station idx, sec_cnt).
type InCallList = Vec<(usize, String, String, i64, u8, i64, usize)>;
/// Join key for a train's departure row: (code, origin station, depart time).
type DepKey = (String, String, String);
/// Join key for a train's arrival row: (code, origin station, depart time, dataset index).
type ArrKey = (String, String, String, u8);
/// Station-pair key used throughout the pipeline.
type PairKey = (String, String);
/// Routed track paths per station pair: (path id, vertex-id segments).
type PathMap = HashMap<PairKey, (String, Vec<Vec<i64>>)>;

#[derive(serde::Serialize)]
struct AtlasDep {
    t: usize,
    fs: i64,
    dep: String,
    ts: i64,
    tc: i64,
    arr: String,
    dur: i64,
    stops: u64,
    set: u8,
    km: i64,
}

#[derive(serde::Serialize)]
struct AtlasArr {
    t: usize,
    fs: i64,
    fc: i64,
    dep: String,
    ts: i64,
    arr: String,
    dur: i64,
    stops: u64,
    set: u8,
    km: i64,
}
#[derive(serde::Serialize)]
struct AtlasOrigin {
    zh: String,
    en: String,
    pt: [f64; 2],
    outbound: u64,
    fully_tracked: u64,
    dests: Vec<[i64; 8]>,
    calls: Vec<CallList>,
    flows: Vec<Vec<usize>>,
    chords: Vec<AtlasChord>,
    deps: Vec<AtlasDep>,
    pub dep_secs: Vec<Vec<usize>>,
    inbound: u64,
    srcs: Vec<[i64; 8]>,
    in_calls: Vec<InCallList>,
    in_flows: Vec<Vec<usize>>,
    arrs: Vec<AtlasArr>,
    pub arr_secs: Vec<Vec<usize>>,
}
#[derive(serde::Serialize)]
struct AtlasOut {
    about: String,
    origins: Vec<AtlasOrigin>,
    sections: Vec<AtlasSection>,
    in_sections: Vec<AtlasSection>,
    city_table: Vec<AtlasCity>,
    station_table: Vec<AtlasStation>,
    train_table: Vec<AtlasTrainRef>,
    network: Vec<String>,
    stats: HashMap<String, i64>,
}

/// One train's call at one destination city (first stop in that city).
#[derive(Clone)]
struct CallRaw {
    code: String,
    from_station: String,
    depart: String,
    arr: String,
    dep: String,
    off: i64,
    term: bool,
    leg_cnt: usize,
}

/// One train's boarding at one source city, for the inbound view of the
/// city it later arrives at (first stop in the source city).
#[derive(Clone)]
struct InCallRaw {
    code: String,
    from_station: String,
    depart: String,
    arr: String,
    off: i64,
    started: bool,
    okey_station: String,
    okey_depart: String,
    set: u8,
    leg_start: usize,
}

/// Per (destination city, source city) inbound stats; mirrors DestStats.
#[derive(Default)]
struct InSrcStats {
    total: u64,
    fast: u64,
    originating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    calls: Vec<InCallRaw>,
    first: usize,
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

/// Load ATLAS_LEG_PATHS (if set) into the override map and LEG_PATHS.
/// Keyed by train_no; by public code only when train_no is absent
/// (codes are reused across physical trains).
fn load_leg_paths(map: &mut OverrideMap) {
    let mut paths: LegPathMap = HashMap::new();
    if let Ok(p) = env::var("ATLAS_LEG_PATHS") {
        let recs: Vec<LegPath> = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        println!("leg paths loaded: {} from {}", recs.len(), p);
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

fn main() {
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
    let out_path = env::var("ATLAS_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| files.join("china-flow-atlas-data.json"));
    let overrides_path = env::var("ATLAS_OVERRIDES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("leg_overrides.json"));
    let mut override_map = load_overrides(&overrides_path);
    load_leg_paths(&mut override_map);
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
    // pair geometry, e.g. a staged double-track-canonical set.
    let pp_files: Vec<PathBuf> = match env::var("ATLAS_PAIR_PATHS") {
        Ok(v) => v.split(',').map(PathBuf::from).collect(),
        Err(_) => vec![
            data_dir.join("derived/pair_paths.json"),
            data_dir.join("derived/cs_out/pair_paths.json"),
        ],
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
                        if &tag[k..k + key.len()] == key && tag[k + key.len()] == b'=' && tag[k + key.len() + 1] == b'"' {
                            let start = k + key.len() + 2;
                            let len = tag[start..].iter().position(|&b| b == b'"')?;
                            return std::str::from_utf8(&tag[start..start + len]).ok()?.parse().ok();
                        }
                        k += 1;
                    }
                    None
                };
                if let (Some(idf), Some(lat), Some(lon)) = (get_f64(b"id"), get_f64(b"lat"), get_f64(b"lon")) {
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

    // ---- HSR edges & nodes from china-rail.osm ways (highspeed=yes or maxspeed>=200) ----
    let (hsr_edges, conv_edges, hsr_nodes) = {
        use quick_xml::events::{BytesStart, Event};
        use quick_xml::Reader;
        let attr = |e: &BytesStart, key: &[u8]| -> String {
            for a in e.attributes().flatten() {
                if a.key.as_ref() == key {
                    return a
                        .unescape_value()
                        .map(|c| c.into_owned())
                        .unwrap_or_default();
                }
            }
            String::new()
        };
        let parse_speed = |v: &str| -> Option<f64> {
            let first = v.split([';', ',']).next()?.trim();
            let num: String = first
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            let x: f64 = num.parse().ok()?;
            let x = if first.ends_with("mph") { x * 1.609 } else { x };
            (5.0..=450.0).contains(&x).then_some(x)
        };
        let mut reader = Reader::from_reader(data.as_slice());
        let mut buf: Vec<u8> = Vec::with_capacity(1 << 14);
        let mut in_way = false;
        let mut is_rail = false;
        let mut highspeed = false;
        let mut maxspeed: Option<f64> = None;
        let mut refs: Vec<i64> = Vec::new();
        let mut hsr_edges: HashSet<(i64, i64)> = HashSet::new();
        let mut conv_edges: HashSet<(i64, i64)> = HashSet::new();
        let mut hsr_nodes: HashSet<i64> = HashSet::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) if e.name().as_ref() == b"way" => {
                    in_way = true;
                    is_rail = false;
                    highspeed = false;
                    maxspeed = None;
                    refs.clear();
                }
                Ok(Event::Empty(e)) if in_way && e.name().as_ref() == b"nd" => {
                    if let Ok(r) = attr(&e, b"ref").parse::<i64>() {
                        refs.push(r);
                    }
                }
                Ok(Event::Empty(e)) if in_way && e.name().as_ref() == b"tag" => {
                    let k = attr(&e, b"k");
                    let v = attr(&e, b"v");
                    match k.as_str() {
                        "railway" if v == "rail" || v == "ferry" => is_rail = true,
                        "highspeed" if v == "yes" => highspeed = true,
                        "maxspeed" => maxspeed = parse_speed(&v),
                        _ => {}
                    }
                }
                Ok(Event::End(e)) if e.name().as_ref() == b"way" => {
                    in_way = false;
                    if is_rail && refs.len() >= 2 {
                        let is_hsr = highspeed || maxspeed.is_some_and(|s| s >= 200.0);
                        if is_hsr {
                            for &id in &refs {
                                hsr_nodes.insert(id);
                            }
                            for w in refs.windows(2) {
                                let e = if w[0] < w[1] {
                                    (w[0], w[1])
                                } else {
                                    (w[1], w[0])
                                };
                                hsr_edges.insert(e);
                            }
                        } else {
                            for w in refs.windows(2) {
                                let e = if w[0] < w[1] {
                                    (w[0], w[1])
                                } else {
                                    (w[1], w[0])
                                };
                                conv_edges.insert(e);
                            }
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
        (hsr_edges, conv_edges, hsr_nodes)
    };
    let chain_hsr = |chain: &[i64]| -> u8 {
        let total = chain.len().saturating_sub(1);
        let hsr_n = chain
            .windows(2)
            .filter(|w| {
                let e = if w[0] < w[1] {
                    (w[0], w[1])
                } else {
                    (w[1], w[0])
                };
                hsr_edges.contains(&e)
                    || (!conv_edges.contains(&e)
                        && hsr_nodes.contains(&w[0])
                        && hsr_nodes.contains(&w[1]))
            })
            .count();
        u8::from(total > 0 && hsr_n * 2 >= total)
    };

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
            println!("Adding Lhasa (拉萨) as a special featured origin city ({} outbound trains)", n);
            selected.push("拉萨".to_string());
        }
    }
    if !selected.contains(&"香港".to_string()) {
        if let Some((_, n)) = hk_entry {
            println!("Adding Hong Kong (香港) as a special featured origin city ({} outbound trains)", n);
            selected.push("香港".to_string());
        }
    }
    for th in [300u64, 200, 150, 100, 75, 50, 25, 10] {
        println!(
            "TIER outbound >= {}: {} cities",
            th,
            ranked.iter().filter(|(_, n)| *n >= th).count()
        );
    }
    println!("total cities with >= 1 outbound train: {}", ranked.len());
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
    let mut city_table: Vec<AtlasCity> = Vec::new();
    let mut city_idx: HashMap<String, i64> = HashMap::new();
    let mut station_table: Vec<AtlasStation> = Vec::new();
    let mut station_idx: HashMap<String, i64> = HashMap::new();
    let mut train_table: Vec<AtlasTrainRef> = Vec::new();
    let mut train_idx: HashMap<(String, String), usize> = HashMap::new();

    // ---- per-city work ----
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
        km: f64,
        leg_keys: Vec<(String, String, String)>,
    }
    type TrainLegs = (usize, Vec<(String, String, String)>);
    struct CityWork {
        zh: String,
        outbound: u64,
        fully_tracked: u64,
        legs: Vec<((String, String, String), u64)>,
        dests: Vec<(String, DestStats)>,
        deps: Vec<DepRaw>,
        home_pt: [f64; 2],
        train_leg_keys: Vec<TrainLegs>,
    }
    let mut works: Vec<CityWork> = Vec::new();
    let mut throat_stations: HashSet<String> = HashSet::new();
    for home_city in selected.iter() {
        let mut out_stats: HashMap<String, DestStats> = HashMap::new();
        let mut counter = 0usize;
        let mut leg_count: HashMap<(String, String, String), u64> = HashMap::new();
        let mut deps: Vec<DepRaw> = Vec::new();
        let mut outbound = 0u64;
        let mut train_legs: Vec<TrainLegs> = Vec::new();
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
            let mut legs: Vec<(String, String, String)> = Vec::new();
            let mut leg_prefix: Vec<usize> = vec![0; names.len()];
            for k in cd_idx..(names.len() - 1) {
                let (a, b) = (names[k].clone(), names[k + 1].clone());
                if a != b {
                    let key = leg_key3(&override_map, t, &a, &b);
                    *leg_count.entry(key.clone()).or_insert(0) += 1;
                    legs.push(key);
                }
                leg_prefix[k + 1] = legs.len();
            }
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
                km: -1.0,
                leg_keys: legs.clone(),
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
                let tt = travel_time(&t.stops, cd_idx, j);
                if let Some(ttv) = tt {
                    if ttv > 0 && ttv < 6000 {
                        e.times.push(ttv);
                    }
                }
                if cum_ok && cum_km > 0.0 {
                    e.rail.push(cum_km);
                }
                let off = match (mins(&t.stops[cd_idx].depart), tt) {
                    (Some(dm), Some(ttv)) => (dm + ttv) / 1440,
                    _ => 0,
                };
                e.calls.push(CallRaw {
                    code: t.code.clone(),
                    from_station: names[cd_idx].clone(),
                    depart: t.stops[cd_idx].depart.clone(),
                    arr: t.stops[j].arrive.clone(),
                    dep: t.stops[j].depart.clone(),
                    off,
                    term: final_city == dest,
                    leg_cnt: leg_prefix[j],
                });
            }
            if cum_ok && cum_km > 0.0 {
                if let Some(d0) = deps.last_mut() {
                    d0.km = cum_km;
                }
            }
            train_legs.push((class_idx(&t.train_class), legs));
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
        for (_, legs) in train_legs.iter() {
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

    // ---- inbound works: for each selected city, every train arriving there.
    // Mirror of the outbound pass. cd_in = the train's first stop in the city
    // at index >= 1 (a real arrival). Sources = every distinct city boarded
    // before a later arrival in this city; per source, the arrival used is
    // the first home-city stop AFTER boarding, which makes the pair identity
    // srcs[X][P].total == dests[P][X].total exact (checked at assembly).
    struct InArrRaw {
        code: String,
        class: String,
        from_station: String,
        from_city: String,
        depart: String,
        arr_station: String,
        arrive: String,
        dur: Option<i64>,
        stops_before: u64,
        set: u8,
        km: f64,
        leg_keys: Vec<(String, String, String)>,
    }
    struct InCityWork {
        zh: String,
        arrivals: u64,
        sources: Vec<(String, InSrcStats)>,
        arrs: Vec<InArrRaw>,
        home_pt: [f64; 2],
        train_leg_keys: Vec<TrainLegs>,
    }
    let mut in_works: Vec<InCityWork> = Vec::new();
    for home_city in selected.iter() {
        let mut src_stats: HashMap<String, InSrcStats> = HashMap::new();
        let mut counter = 0usize;
        let mut arrs: Vec<InArrRaw> = Vec::new();
        let mut train_leg_keys_in: Vec<TrainLegs> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let cd_in = match (1..cities.len()).find(|&j| &cities[j] == home_city) {
                Some(j) => j,
                None => continue,
            };
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            // prefix track distances from stop 0: cumulative km + bad-leg count
            let mut pref_km: Vec<f64> = vec![0.0; cities.len()];
            let mut pref_bad: Vec<i64> = vec![0; cities.len()];
            for k in 1..cities.len() {
                let (a, b) = (names[k - 1].clone(), names[k].clone());
                pref_bad[k] = pref_bad[k - 1];
                pref_km[k] = pref_km[k - 1];
                if a != b {
                    match leg_km(&override_map, &pair_len, t, &a, &b) {
                        Some(l) => pref_km[k] += l,
                        None => pref_bad[k] += 1,
                    }
                }
            }
            let journey_km = if pref_bad[cd_in] == 0 && pref_km[cd_in] > 0.0 {
                pref_km[cd_in]
            } else {
                -1.0
            };
            let mut legs: Vec<(String, String, String)> = Vec::new();
            let mut leg_prefix: Vec<usize> = vec![0; cities.len()];
            for k in 0..cd_in {
                let (a, b) = (names[k].clone(), names[k + 1].clone());
                if a != b {
                    legs.push(leg_key3(&override_map, t, &a, &b));
                }
                leg_prefix[k + 1] = legs.len();
            }
            for p in leg_prefix.iter_mut().skip(cd_in + 1) {
                *p = legs.len();
            }
            arrs.push(InArrRaw {
                code: t.code.clone(),
                class: t.train_class.clone(),
                from_station: names[0].clone(),
                from_city: cities[0].clone(),
                depart: t.stops[0].depart.clone(),
                arr_station: names[cd_in].clone(),
                arrive: t.stops[cd_in].arrive.clone(),
                dur: travel_time(&t.stops, 0, cd_in),
                stops_before: cd_in as u64,
                set: if ti < d1_len { 0 } else { 1 },
                km: journey_km,
                leg_keys: legs.clone(),
            });
            // sources: distinct cities (first index each), home city excluded
            let mut seen_src: HashSet<String> = HashSet::new();
            let mut src_list: Vec<(String, usize)> = Vec::new();
            // k walks cities/names in lockstep; the index is the join.
            #[allow(clippy::needless_range_loop)]
            for k in 0..cities.len() {
                if &cities[k] == home_city {
                    continue;
                }
                if seen_src.insert(cities[k].clone()) {
                    src_list.push((cities[k].clone(), k));
                }
            }
            for (pcity, p_idx) in src_list.iter() {
                let p_idx = *p_idx;
                let arr_j = match (p_idx + 1..cities.len()).find(|&j| &cities[j] == home_city) {
                    Some(j) => j,
                    None => continue,
                };
                let e = src_stats.entry(pcity.clone()).or_insert_with(|| {
                    let v = counter;
                    counter += 1;
                    InSrcStats {
                        first: v,
                        ..Default::default()
                    }
                });
                e.total += 1;
                if is_fast {
                    e.fast += 1;
                }
                if p_idx == 0 {
                    e.originating += 1;
                }
                let tt = travel_time(&t.stops, p_idx, arr_j);
                if let Some(ttv) = tt {
                    if ttv > 0 && ttv < 6000 {
                        e.times.push(ttv);
                    }
                }
                if pref_bad[arr_j] - pref_bad[p_idx] == 0 {
                    let d = pref_km[arr_j] - pref_km[p_idx];
                    if d > 0.0 {
                        e.rail.push(d);
                    }
                }
                let off = match (mins(&t.stops[p_idx].depart), tt) {
                    (Some(dm), Some(ttv)) => (dm + ttv) / 1440,
                    _ => 0,
                };
                e.calls.push(InCallRaw {
                    code: t.code.clone(),
                    from_station: names[p_idx].clone(),
                    depart: t.stops[p_idx].depart.clone(),
                    arr: t.stops[arr_j].arrive.clone(),
                    off,
                    started: p_idx == 0,
                    okey_station: names[0].clone(),
                    okey_depart: t.stops[0].depart.clone(),
                    set: if ti < d1_len { 0 } else { 1 },
                    leg_start: leg_prefix[p_idx.min(cd_in)],
                });
            }
            train_leg_keys_in.push((class_idx(&t.train_class), legs));
        }
        arrs.sort_by(|x, y| x.arrive.cmp(&y.arrive).then(x.code.cmp(&y.code)));
        let mut sources: Vec<(String, InSrcStats)> = src_stats.into_iter().collect();
        sources.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.1.first.cmp(&b.1.first)));
        let hp = city_pt.get(home_city).copied().unwrap_or([30.63, 104.13]);
        println!(
            "IN {}: arrivals {} sources {}",
            home_city,
            arrs.len(),
            sources.len()
        );
        in_works.push(InCityWork {
            zh: home_city.clone(),
            arrivals: arrs.len() as u64,
            sources,
            arrs,
            home_pt: [hp[1], hp[0]],
            train_leg_keys: train_leg_keys_in,
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
    // atomic edge -> per-city DISTINCT train counts: each train counts at
    // most once per edge, no matter how many of its legs' paths overlap
    // there (adjacent-leg path overlap near stations otherwise inflates
    // short sections between close stations).
    let mut edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    let mut edge_class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
    for (ci, w) in works.iter().enumerate() {
        for (cidx, legs) in w.train_leg_keys.iter() {
            let mut eset: HashSet<(i64, i64)> = HashSet::new();
            for key in legs.iter() {
                let seqs = match leg_seqs(key, &leg_cache, &variant_cache) {
                    Some(s) => s,
                    None => continue,
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
                edge_class_counts
                    .entry(e)
                    .or_default()
                    .entry(ci)
                    .or_insert([0; 8])[*cidx] += 1;
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
    let mut edge_to_sec: HashMap<(i64, i64), usize> = HashMap::new();
    let mut sections: Vec<AtlasSection> = Vec::new();
    let mut flows_per_city: Vec<Vec<Vec<usize>>> = vec![Vec::new(); works.len()];
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
        for win in chain.windows(2) {
            edge_to_sec.insert(ekey(win[0], win[1]), sec_idx);
        }
        let a_nm = nearest_station(simp[0]);
        let b_nm = nearest_station(*simp.last().unwrap());
        let a_i = if a_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &a_nm, &city_en)
        };
        let b_i = if b_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &b_nm, &city_en)
        };
        sections.push(AtlasSection {
            a: a_i,
            b: b_i,
            g: polyline_encode(&simp),
            h: chain_hsr(chain),
        });
        let e0 = ekey(chain[0], chain[1]);
        for (ci, n) in sig_list[*sid as usize].iter() {
            let cls_counts = edge_class_counts
                .get(&e0)
                .and_then(|m| m.get(ci))
                .copied()
                .unwrap_or([0; 8]);
            flows_per_city[*ci].push(pack_flow_row(sec_idx, *n as usize, &cls_counts));
        }
    }
    for f in flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    println!("sections: {} points: {}", sections.len(), total_sec_pts);

    // ---- inbound atomic sections: same machinery, indexed by dest city ----
    let mut in_edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    let mut in_edge_class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
    for (ci, w) in in_works.iter().enumerate() {
        for (cidx, legs) in w.train_leg_keys.iter() {
            let mut eset: HashSet<(i64, i64)> = HashSet::new();
            for key in legs.iter() {
                let seqs = match leg_seqs(key, &leg_cache, &variant_cache) {
                    Some(s) => s,
                    None => continue,
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
                *in_edge_counts.entry(e).or_default().entry(ci).or_insert(0) += 1;
                in_edge_class_counts
                    .entry(e)
                    .or_default()
                    .entry(ci)
                    .or_insert([0; 8])[*cidx] += 1;
            }
        }
    }
    println!("union inbound atomic edges: {}", in_edge_counts.len());
    let mut in_sig_ids: HashMap<Vec<(usize, u64)>, u32> = HashMap::new();
    let mut in_sig_list: Vec<Vec<(usize, u64)>> = Vec::new();
    let mut in_edge_sig: HashMap<(i64, i64), u32> = HashMap::new();
    for (e, m) in in_edge_counts.iter() {
        let mut sig: Vec<(usize, u64)> = m.iter().map(|(c, n)| (*c, *n)).collect();
        sig.sort();
        let id = match in_sig_ids.get(&sig) {
            Some(id) => *id,
            None => {
                let id = in_sig_list.len() as u32;
                in_sig_list.push(sig.clone());
                in_sig_ids.insert(sig, id);
                id
            }
        };
        in_edge_sig.insert(*e, id);
    }
    let mut in_nadj: HashMap<i64, Vec<(i64, u32)>> = HashMap::new();
    for (e, sid) in in_edge_sig.iter() {
        in_nadj.entry(e.0).or_default().push((e.1, *sid));
        in_nadj.entry(e.1).or_default().push((e.0, *sid));
    }
    let mut in_used: HashSet<(i64, i64)> = HashSet::new();
    let mut in_section_chains: Vec<(u32, Vec<i64>)> = Vec::new();
    for (e, sid) in in_edge_sig.iter() {
        if in_used.contains(e) {
            continue;
        }
        let sid = *sid;
        let mut chain: Vec<i64> = vec![e.0, e.1];
        in_used.insert(*e);
        loop {
            let cur = *chain.last().unwrap();
            let prev = chain[chain.len() - 2];
            let cands: Vec<i64> = in_nadj
                .get(&cur)
                .map(|v| {
                    v.iter()
                        .filter(|(n, s)| *n != prev && *s == sid)
                        .map(|(n, _)| *n)
                        .collect()
                })
                .unwrap_or_default();
            if cands.len() == 1 && !in_used.contains(&ekey(cur, cands[0])) {
                in_used.insert(ekey(cur, cands[0]));
                chain.push(cands[0]);
            } else {
                break;
            }
        }
        loop {
            let cur = chain[0];
            let next = chain[1];
            let cands: Vec<i64> = in_nadj
                .get(&cur)
                .map(|v| {
                    v.iter()
                        .filter(|(n, s)| *n != next && *s == sid)
                        .map(|(n, _)| *n)
                        .collect()
                })
                .unwrap_or_default();
            if cands.len() == 1 && !in_used.contains(&ekey(cur, cands[0])) {
                in_used.insert(ekey(cur, cands[0]));
                chain.insert(0, cands[0]);
            } else {
                break;
            }
        }
        in_section_chains.push((sid, chain));
    }
    let mut in_edge_to_sec: HashMap<(i64, i64), usize> = HashMap::new();
    let mut in_sections: Vec<AtlasSection> = Vec::new();
    let mut in_flows_per_city: Vec<Vec<Vec<usize>>> = vec![Vec::new(); in_works.len()];
    let mut in_total_sec_pts = 0usize;
    for (sid, chain) in in_section_chains.iter() {
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
        in_total_sec_pts += simp.len();
        let sec_idx = in_sections.len();
        for win in chain.windows(2) {
            in_edge_to_sec.insert(ekey(win[0], win[1]), sec_idx);
        }
        let a_nm = nearest_station(simp[0]);
        let b_nm = nearest_station(*simp.last().unwrap());
        let a_i = if a_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &a_nm, &city_en)
        };
        let b_i = if b_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &b_nm, &city_en)
        };
        in_sections.push(AtlasSection {
            a: a_i,
            b: b_i,
            g: polyline_encode(&simp),
            h: chain_hsr(chain),
        });
        let e0 = ekey(chain[0], chain[1]);
        for (ci, n) in in_sig_list[*sid as usize].iter() {
            let cls_counts = in_edge_class_counts
                .get(&e0)
                .and_then(|m| m.get(ci))
                .copied()
                .unwrap_or([0; 8]);
            in_flows_per_city[*ci].push(pack_flow_row(sec_idx, *n as usize, &cls_counts));
        }
    }
    for f in in_flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    println!(
        "in_sections: {} points: {}",
        in_sections.len(),
        in_total_sec_pts
    );

    // ---- assemble origins ----
    let mut pair_mismatch = 0u64;
    let mut origins: Vec<AtlasOrigin> = Vec::new();
    for (ci, w) in works.iter().enumerate() {
        let mut dep_secs: Vec<Vec<usize>> = Vec::with_capacity(w.deps.len());
        let mut dep_leg_sec_cnt: Vec<Vec<usize>> = Vec::with_capacity(w.deps.len());
        for d in w.deps.iter() {
            let mut secs_ord: Vec<usize> = Vec::new();
            let mut seen_s: HashSet<usize> = HashSet::new();
            let mut prefix_cnt: Vec<usize> = vec![0; d.leg_keys.len() + 1];
            for (li, key) in d.leg_keys.iter().enumerate() {
                if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                    for s in seqs.iter() {
                        for win in s.windows(2) {
                            if let Some(&sidx) = edge_to_sec.get(&ekey(win[0], win[1])) {
                                if seen_s.insert(sidx) {
                                    secs_ord.push(sidx);
                                }
                            }
                        }
                    }
                }
                prefix_cnt[li + 1] = secs_ord.len();
            }
            dep_secs.push(secs_ord);
            dep_leg_sec_cnt.push(prefix_cnt);
        }
        let dep_lookup: HashMap<DepKey, usize> = w
            .deps
            .iter()
            .enumerate()
            .map(|(i, d)| {
                (
                    (d.code.clone(), d.from_station.clone(), d.depart.clone()),
                    i,
                )
            })
            .collect();
        let mut dests: Vec<[i64; 8]> = Vec::new();
        let mut calls_out: Vec<CallList> = Vec::new();
        for (zh, st) in w.dests.iter() {
            let dp = match city_pt.get(zh) {
                Some(p) => *p,
                None => continue,
            };
            let idx = intern_city(&mut city_table, &mut city_idx, zh, &city_en, &city_pt);
            let mut times = st.times.clone();
            times.sort();
            let fastest = times.first().copied().unwrap_or(-1);
            let median_v = if times.is_empty() {
                -1
            } else {
                times[times.len() / 2]
            };
            // crow-flies km (origin pt -> destination city pt) and rail km
            // (median over direct trains of summed track leg lengths)
            let crow = hav_km_ll(w.home_pt, [dp[1], dp[0]]).round() as i64;
            let mut rail = st.rail.clone();
            rail.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let rail_v = if rail.is_empty() {
                -1
            } else {
                rail[rail.len() / 2].round() as i64
            };
            dests.push([
                idx,
                st.total as i64,
                st.fast as i64,
                st.terminating as i64,
                fastest,
                median_v,
                crow,
                rail_v,
            ]);
            let mut cl: Vec<(usize, String, String, i64, u8, usize)> = Vec::new();
            for c in st.calls.iter() {
                if let Some(di) =
                    dep_lookup.get(&(c.code.clone(), c.from_station.clone(), c.depart.clone()))
                {
                    let sec_cnt = dep_leg_sec_cnt[*di]
                        .get(c.leg_cnt)
                        .copied()
                        .unwrap_or(dep_secs[*di].len());
                    cl.push((
                        *di,
                        c.arr.clone(),
                        c.dep.clone(),
                        c.off,
                        if c.term { 1 } else { 0 },
                        sec_cnt,
                    ));
                }
            }
            cl.sort_by_key(|r| (r.3, mins(&r.1).unwrap_or(0)));
            if cl.len() as u64 != st.total {
                println!(
                    "CALLS MISMATCH {} -> {}: {} calls vs total {}",
                    w.zh,
                    zh,
                    cl.len(),
                    st.total
                );
            }
            calls_out.push(cl);
        }
        let mut chords: Vec<AtlasChord> = Vec::new();
        for (key, n) in w.legs.iter() {
            let resolved = leg_seqs(key, &leg_cache, &variant_cache).is_some();
            if resolved {
                continue;
            }
            if let (Some(p1), Some(p2)) = (station_pt(&key.0), station_pt(&key.1)) {
                let a_i = intern_station(&mut station_table, &mut station_idx, &key.0, &city_en);
                let b_i = intern_station(&mut station_table, &mut station_idx, &key.1, &city_en);
                chords.push(AtlasChord {
                    a: a_i,
                    b: b_i,
                    n: *n,
                    g: polyline_encode(&[[p1[1], p1[0]], [p2[1], p2[0]]]),
                });
            }
        }
        let mut deps: Vec<AtlasDep> = Vec::new();
        for d in w.deps.iter() {
            let t_i = intern_train(&mut train_table, &mut train_idx, &d.code, &d.class);
            let fs_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &d.from_station,
                &city_en,
            );
            let ts_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &d.to_station,
                &city_en,
            );
            let tc_i = intern_city(
                &mut city_table,
                &mut city_idx,
                &d.to_city,
                &city_en,
                &city_pt,
            );
            deps.push(AtlasDep {
                t: t_i,
                fs: fs_i,
                dep: d.depart.clone(),
                ts: ts_i,
                tc: tc_i,
                arr: d.arrive.clone(),
                dur: d.dur.unwrap_or(-1),
                stops: d.stops_after,
                set: d.set,
                km: if d.km > 0.0 { d.km.round() as i64 } else { -1 },
            });
        }
        // ---- inbound assembly for this city ----
        let iw = &in_works[ci];
        let mut arr_secs: Vec<Vec<usize>> = Vec::with_capacity(iw.arrs.len());
        let mut arr_leg_sec_cnt: Vec<Vec<usize>> = Vec::with_capacity(iw.arrs.len());
        for a in iw.arrs.iter() {
            let mut secs_ord: Vec<usize> = Vec::new();
            let mut seen_s: HashSet<usize> = HashSet::new();
            let mut suffix_cnt: Vec<usize> = vec![0; a.leg_keys.len() + 1];
            for (li, key) in a.leg_keys.iter().enumerate().rev() {
                if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                    for s in seqs.iter().rev() {
                        for win in s.windows(2).rev() {
                            if let Some(&sidx) = in_edge_to_sec.get(&ekey(win[0], win[1])) {
                                if seen_s.insert(sidx) {
                                    secs_ord.push(sidx);
                                }
                            }
                        }
                    }
                }
                suffix_cnt[li] = secs_ord.len();
            }
            arr_secs.push(secs_ord);
            arr_leg_sec_cnt.push(suffix_cnt);
        }
        let arr_lookup: HashMap<ArrKey, usize> = iw
            .arrs
            .iter()
            .enumerate()
            .map(|(i, a)| {
                (
                    (
                        a.code.clone(),
                        a.from_station.clone(),
                        a.depart.clone(),
                        a.set,
                    ),
                    i,
                )
            })
            .collect();
        let mut srcs: Vec<[i64; 8]> = Vec::new();
        let mut in_calls_out: Vec<InCallList> = Vec::new();
        for (zh, st) in iw.sources.iter() {
            let dp = match city_pt.get(zh) {
                Some(p) => *p,
                None => continue,
            };
            let idx = intern_city(&mut city_table, &mut city_idx, zh, &city_en, &city_pt);
            let mut times = st.times.clone();
            times.sort();
            let fastest = times.first().copied().unwrap_or(-1);
            let median_v = if times.is_empty() {
                -1
            } else {
                times[times.len() / 2]
            };
            let crow = hav_km_ll(iw.home_pt, [dp[1], dp[0]]).round() as i64;
            let mut rail = st.rail.clone();
            rail.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let rail_v = if rail.is_empty() {
                -1
            } else {
                rail[rail.len() / 2].round() as i64
            };
            srcs.push([
                idx,
                st.total as i64,
                st.fast as i64,
                st.originating as i64,
                fastest,
                median_v,
                crow,
                rail_v,
            ]);
            let mut cl: Vec<(usize, String, String, i64, u8, i64, usize)> = Vec::new();
            for c in st.calls.iter() {
                if let Some(ai) = arr_lookup.get(&(
                    c.code.clone(),
                    c.okey_station.clone(),
                    c.okey_depart.clone(),
                    c.set,
                )) {
                    let bfs_i = intern_station(
                        &mut station_table,
                        &mut station_idx,
                        &c.from_station,
                        &city_en,
                    );
                    let sec_cnt = arr_leg_sec_cnt[*ai]
                        .get(c.leg_start)
                        .copied()
                        .unwrap_or(arr_secs[*ai].len());
                    cl.push((
                        *ai,
                        c.depart.clone(),
                        c.arr.clone(),
                        c.off,
                        if c.started { 1 } else { 0 },
                        bfs_i,
                        sec_cnt,
                    ));
                }
            }
            cl.sort_by_key(|r| (r.3, mins(&r.2).unwrap_or(0)));
            if cl.len() as u64 != st.total {
                println!(
                    "IN CALLS MISMATCH {} <- {}: {} calls vs total {}",
                    iw.zh,
                    zh,
                    cl.len(),
                    st.total
                );
            }
            in_calls_out.push(cl);
            // pair identity: srcs[X][P] must equal dests[P][X] when P is selected
            if let Some(pi) = selected.iter().position(|c| c == zh) {
                match works[pi].dests.iter().find(|(dz, _)| dz == &iw.zh) {
                    Some((_, dst)) => {
                        if dst.total != st.total {
                            pair_mismatch += 1;
                            println!(
                                "PAIR IDENTITY MISMATCH {} -> {}: out {} vs in {}",
                                zh, iw.zh, dst.total, st.total
                            );
                        }
                    }
                    None => {
                        pair_mismatch += 1;
                        println!("PAIR IDENTITY MISSING {} -> {}", zh, iw.zh);
                    }
                }
            }
        }
        let mut arrs_out: Vec<AtlasArr> = Vec::new();
        for a in iw.arrs.iter() {
            let t_i = intern_train(&mut train_table, &mut train_idx, &a.code, &a.class);
            let fs_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &a.from_station,
                &city_en,
            );
            let fc_i = intern_city(
                &mut city_table,
                &mut city_idx,
                &a.from_city,
                &city_en,
                &city_pt,
            );
            let ts_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &a.arr_station,
                &city_en,
            );
            arrs_out.push(AtlasArr {
                t: t_i,
                fs: fs_i,
                fc: fc_i,
                dep: a.depart.clone(),
                ts: ts_i,
                arr: a.arrive.clone(),
                dur: a.dur.unwrap_or(-1),
                stops: a.stops_before,
                set: a.set,
                km: if a.km > 0.0 { a.km.round() as i64 } else { -1 },
            });
        }
        origins.push(AtlasOrigin {
            zh: w.zh.clone(),
            en: en(&w.zh),
            pt: w.home_pt,
            outbound: w.outbound,
            fully_tracked: w.fully_tracked,
            dests,
            calls: calls_out,
            flows: flows_per_city[ci].clone(),
            chords,
            deps,
            dep_secs,
            inbound: iw.arrivals,
            srcs,
            in_calls: in_calls_out,
            in_flows: in_flows_per_city[ci].clone(),
            arrs: arrs_out,
            arr_secs,
        });
    }

    println!("pair identity mismatches: {}", pair_mismatch);
    println!(
        "variant legs: {} resolved via override tiling, {} fell back to base pair geometry",
        variant_stats.0, variant_stats.1
    );
    // ---- network backdrop (shared, polyline-encoded) ----
    let mut network: Vec<String> = Vec::new();
    {
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for (key, (_, segs)) in path_map.iter() {
            if !seen.insert(key.clone()) {
                continue;
            }
            for s in segs {
                let c = seg_coords(s);
                if c.len() >= 2 {
                    let simp = dp_keep(&c, 0.008);
                    let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 3)).collect();
                    if simp.len() >= 2 {
                        network.push(polyline_encode(&simp));
                    }
                }
            }
        }
    }
    println!("network polylines: {}", network.len());

    let mut stats: HashMap<String, i64> = HashMap::new();
    stats.insert("origins".into(), origins.len() as i64);
    stats.insert("sections".into(), sections.len() as i64);
    stats.insert("in_sections".into(), in_sections.len() as i64);
    stats.insert("section_points".into(), total_sec_pts as i64);
    stats.insert("city_table".into(), city_table.len() as i64);
    stats.insert("station_table".into(), station_table.len() as i64);
    stats.insert("train_table".into(), train_table.len() as i64);
    stats.insert("network_polylines".into(), network.len() as i64);
    let out = AtlasOut {
        about: "China Rail Flow Atlas - Minard-style outbound flow maps for China's top 100 rail cities. Shared national track-section atlas (each section = a stretch of track with constant per-city train counts); every origin city is a sparse index (section, trains/day) into it, plus destination stats and departures. Track geometry: OpenStreetMap. Timetables: 12306 timetables Wed 2026-10-21 (5,043 trains, trunk) and Wed 2026-10-28 (2,210 intercity C/S trains). Flow width = trains/day summed over each shared track section. Dashed chords = legs with no track routing. Geometry strings are Google-polyline-encoded at 1e5 precision, [lat, lon] order.".into(),
        origins, sections, in_sections, city_table, station_table, train_table, network, stats,
    };
    let txt = serde_json::to_string(&out).unwrap();
    fs::write(&out_path, &txt).unwrap();
    println!(
        "wrote {} ({:.2} MB)",
        out_path.display(),
        txt.len() as f64 / 1e6
    );
}

fn intern_city(
    table: &mut Vec<AtlasCity>,
    idx: &mut HashMap<String, i64>,
    zh: &str,
    city_en: &HashMap<String, String>,
    city_pt: &HashMap<String, [f64; 2]>,
) -> i64 {
    if let Some(i) = idx.get(zh) {
        return *i;
    }
    let pt = city_pt.get(zh).map(|p| [p[1], p[0]]).unwrap_or([0.0, 0.0]);
    let i = table.len() as i64;
    table.push(AtlasCity {
        zh: zh.to_string(),
        en: city_en.get(zh).cloned().unwrap_or_else(|| zh.to_string()),
        pt,
    });
    idx.insert(zh.to_string(), i);
    i
}

fn intern_station(
    table: &mut Vec<AtlasStation>,
    idx: &mut HashMap<String, i64>,
    zh: &str,
    city_en: &HashMap<String, String>,
) -> i64 {
    if let Some(i) = idx.get(zh) {
        return *i;
    }
    let i = table.len() as i64;
    table.push(AtlasStation {
        zh: zh.to_string(),
        en: station_en(zh, city_en),
    });
    idx.insert(zh.to_string(), i);
    i
}

fn intern_train(
    table: &mut Vec<AtlasTrainRef>,
    idx: &mut HashMap<(String, String), usize>,
    code: &str,
    class: &str,
) -> usize {
    let k = (code.to_string(), class.to_string());
    if let Some(i) = idx.get(&k) {
        return *i;
    }
    let i = table.len();
    table.push(AtlasTrainRef {
        code: code.to_string(),
        class: class.to_string(),
    });
    idx.insert(k, i);
    i
}
