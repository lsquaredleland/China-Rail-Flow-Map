//! Everything specific to China's rail network and 12306 timetables: the city
//! gazetteer (with corrections) and the train-class letters. Generic pipeline
//! code must not hard-code place names; it takes a resolver from here.

pub mod classes;
pub mod files;
pub mod gazetteer;
pub mod station_en;

pub use classes::class_idx;
pub use gazetteer::{city2, city_of};
pub use station_en::station_en;
