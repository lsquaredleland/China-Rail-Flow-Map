//! China-specific English station names: the curated table plus place-name
//! composition from the city gazetteer.

use std::collections::HashMap;

/// English for a station name: curated specials, else base place EN from the
/// city gazetteer plus a suffix word (East/South/West/North/Airport).
pub fn station_en(name: &str, city_en: &HashMap<String, String>) -> String {
    static STATION_EN: std::sync::LazyLock<HashMap<String, String>> =
        std::sync::LazyLock::new(|| {
            serde_json::from_str(include_str!("../../../../data/station_en.json"))
                .unwrap_or_default()
        });
    if let Some(v) = STATION_EN.get(name) {
        return v.clone();
    }
    let specials: &[(&str, &str)] = &[
        ("广州白云", "Guangzhou Baiyun"),
        ("广州南", "Guangzhou South"),
        ("广州东", "Guangzhou East"),
        ("广州北", "Guangzhou North"),
        ("广州西", "Guangzhou West"),
        ("广州新塘", "Guangzhou Xintang"),
        ("广州", "Guangzhou"),
        ("北京南", "Beijing South"),
        ("北京西", "Beijing West"),
        ("北京北", "Beijing North"),
        ("北京东", "Beijing East"),
        ("北京大兴", "Beijing Daxing"),
        ("北京朝阳", "Beijing Chaoyang"),
        ("北京丰台", "Beijing Fengtai"),
        ("北京通州", "Beijing Tongzhou"),
        ("北京", "Beijing"),
        ("上海虹桥", "Shanghai Hongqiao"),
        ("上海松江", "Shanghai Songjiang"),
        ("上海南", "Shanghai South"),
        ("上海西", "Shanghai West"),
        ("上海", "Shanghai"),
        ("深圳北", "Shenzhen North"),
        ("深圳坪山", "Shenzhen Pingshan"),
        ("深圳机场北", "Shenzhen Airport North"),
        ("深圳机场", "Shenzhen Airport"),
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
        STATION_EN
            .get(b)
            .cloned()
            .or_else(|| city_en.get(b).cloned())
    };
    if let Some(b) = name.strip_suffix("国际机场") {
        if let Some(e) = base_en(b) {
            return format!("{} International Airport", e);
        }
    }
    if let Some(b) = name.strip_suffix("机场北") {
        if let Some(e) = base_en(b) {
            return format!("{} Airport North", e);
        }
    }
    if let Some(b) = name.strip_suffix("机场南") {
        if let Some(e) = base_en(b) {
            return format!("{} Airport South", e);
        }
    }
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
    base_en(name).unwrap_or_else(|| name.to_string())
}
