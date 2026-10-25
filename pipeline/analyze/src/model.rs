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
}

#[derive(serde::Serialize)]
pub struct AtlasTrainRef {
    pub code: String,
    pub class: String,
}
