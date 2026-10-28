//! Output row types shared by the atlas builder and the audit.

// ================= atlas types =================
#[derive(serde::Serialize)]
pub struct AtlasCity {
    pub zh: String,
    pub en: String,
    pub pt: [f64; 2],
}

#[derive(serde::Serialize)]
pub struct AtlasStation {
    pub zh: String,
    pub en: String,
    /// [lon, lat]; absent when the station has no point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pt: Option<[f64; 2]>,
    /// city_table index of the station's city; absent when that city is not
    /// in city_table (it is never drawn).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<i64>,
    /// True for a major station of an origin city that splits into its
    /// stations at close zoom (atlas `closeup_stations`); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closeup: Option<bool>,
}

#[derive(serde::Serialize)]
pub struct AtlasTrainRef {
    pub code: String,
    pub class: String,
    /// Train-export builds only (`CRFM_SCHEDULE`): one char per date of the
    /// top-level `calendar`, '1' = runs that day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<String>,
    /// Train-export builds only: the export's running pattern.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// Train-export builds only, and only when true: listed as suspended on
    /// every run date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspended: Option<bool>,
}
