import { useEffect, useMemo, useRef, useState } from "react";
import { decompress as brotliDecompress } from "brotli/decompress.js";
import type {
  AtlasData,
  CityPointVM,
  DecodedAtlas,
  DecodedOutline,
  DestVM,
  Direction,
  DistBinFilter,
  DistUnit,
  DurBinFilter,
  InMapData,
  InTablesData,
  OriginVM,
  OutMapData,
  OutTablesData,
  OutlineData,
  SchedulesData,
  SharedData,
  SrcVM,
} from "./types";
import {
  buildOrigin,
  classIndex,
  enName,
  filterOrigin,
  FLOW_CLASSES,
  prepAtlas,
  prepOutline,
} from "./lib";
import CityPicker from "./components/CityPicker";
import MapCanvas, { type MapApi } from "./components/MapCanvas";
import Legend, { type LegendHandle } from "./components/Legend";
import DestinationPanel from "./components/DestinationPanel";
import DeparturesTable from "./components/DeparturesTable";
import Footnote from "./components/Footnote";
import TimelineScrubber from "./components/TimelineScrubber";
import TrainScheduleModal from "./components/TrainScheduleModal";

// The v2 atlas dataset ships in five split files (same origin order
// throughout): the shared tables and geometry, and per direction a map
// file (identity, aggregates, flows) and a tables file (the per-train
// rows). Loading is staged so the map paints before the table data
// arrives:
//   phase 1 — shared + out-map in parallel (plus in-map when the
//     persisted direction is inbound): the map renders and is fully
//     interactive on this data alone;
//   phase 2 — the active direction's tables file, fetched immediately
//     behind phase 1; the departures table and histograms fill in
//     when it lands;
//   phase 3 — the other direction loads the same way on the first
//     flip: its map file (paint), then its tables behind it.
// Every file is fetched at most once and cached for the session; each
// merge goes into the origins in place, by index.
const SHARED_URL = "assets/atlas-v2-shared.json";
const OUT_MAP_URL = "assets/atlas-v2-out-map.json";
const OUT_TABLES_URL = "assets/atlas-v2-out-tables.json";
const IN_MAP_URL = "assets/atlas-v2-in-map.json";
const IN_TABLES_URL = "assets/atlas-v2-in-tables.json";
const OUTLINE_URL = "assets/china-outline.json";
// Tables carry travel-ordered, oriented section paths (fmt 3); older packs
// would draw wrong, so refuse them outright.
function requireFmt3(fmt: unknown, url: string) {
  if (fmt === 3) return;
  const msg = `${url}: unsupported tables format ${String(fmt)} (need fmt 3); rebuild the data pack`;
  console.error(msg);
  throw new Error(msg);
}

const SCHEDULES_URL = "assets/atlas-v2-schedules.json";

// The v2 files carry no `about` blurb (v1 embedded one in the data);
// the text is unchanged apart from the geometry-precision sentence,
// which now states the v2 encoding.
const ABOUT =
  "Minard-style passenger rail flow maps for China's top rail cities. " +
  "Flow line width reflects daily train frequency along each railway corridor. " +
  "In the outbound view, trains are traced from the origin city outward to their destinations; " +
  "in the inbound view, trains are traced from their starting stations through all intermediate calls into the selected city. " +
  "Timetable data is sourced from China Railway (12306), covering 5,043 trunk services and 2,210 intercity C/S services across sample dates in October 2026.";

/* Fetch one dataset file, preferring its Brotli twin (the .br asset):
   1. if the server negotiates the encoding itself (the .br response
      arrives with a Content-Encoding), the browser decompresses
      transparently and the bytes parse as JSON directly;
   2. else decompress the .br bytes through DecompressionStream
      ("brotli") where the browser offers it (Chrome's headless shell,
      for one, does not);
   3. else decompress with the bundled pure-JS Brotli decoder
      (the `brotli` package's decode half, ~91 KB minified) — the path
      this runtime takes: phase 1 transfers shared .br (520,344 B) +
      out-map .br (571,195 B) ≈ 1.09 MB, decoded byte-identical to the
      plain splits;
   4. else fall back to the plain .json split. */
async function fetchData<T>(jsonUrl: string): Promise<T> {
  try {
    const res = await fetch(jsonUrl + ".br");
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      if (u8.length > 0 && u8[0] !== 0x3c) {
        if (u8[0] === 0x7b) {
          return JSON.parse(new TextDecoder().decode(u8)) as T;
        }
        const DS = (
          window as unknown as {
            DecompressionStream?: typeof DecompressionStream;
          }
        ).DecompressionStream;
        if (DS) {
          try {
            const body = new Response(buf).body;
            if (body) {
              const stream = body.pipeThrough(
                new DS("brotli" as CompressionFormat),
              );
              const text = await new Response(stream).text();
              return JSON.parse(text) as T;
            }
          } catch {
            /* no native Brotli stream: use the bundled decoder */
          }
        }
        const out = brotliDecompress(u8);
        return JSON.parse(new TextDecoder().decode(out)) as T;
      }
    }
  } catch {
    /* fall through to the plain split */
  }
  const r = await fetch(jsonUrl);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.json()) as T;
}
function initialDistUnit(): DistUnit {
  try {
    if (window.localStorage && localStorage.getItem("crfa-dist-unit") === "mi")
      return "mi";
  } catch {
    /* storage unavailable: stay on km */
  }
  return "km";
}

function initialInfra(): boolean {
  try {
    if (window.localStorage && localStorage.getItem("crfa-infra") === "1")
      return true;
  } catch {
    /* storage unavailable: stay in flow-width mode */
  }
  return false;
}

function initialDirection(): Direction {
  try {
    if (window.localStorage && localStorage.getItem("crfa-direction") === "in")
      return "in";
  } catch {
    /* storage unavailable: stay outbound */
  }
  return "out";
}

function initialDark(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("theme");
    if (p === "dark" || p === "night") return true;
    if (p === "light" || p === "day") return false;
    const saved = window.sessionStorage && sessionStorage.getItem("crfa-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
  } catch {
    /* storage unavailable */
  }
  return !!(
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function parseInitialCamera(): {
  lon: number;
  lat: number;
  zoom: number;
  scale: number;
} | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get("lat") || "");
    const lon = parseFloat(params.get("lon") || params.get("lng") || "");
    const z = parseFloat(params.get("z") || params.get("zoom") || "");
    if (!isNaN(lat) && !isNaN(lon) && !isNaN(z)) {
      const scale = z <= 25 ? (256 * Math.pow(2, z)) / 360 : z;
      const zoom = z <= 25 ? z : Math.log2((z * 360) / 256);
      return { lon, lat, zoom, scale };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function matchesCity(o: { zh: string; en: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  const qClean = q.replace(/[\s\-_'’]+/g, "");
  const enFixed = enName(o.en).toLowerCase();
  const enRaw = o.en.toLowerCase();
  return (
    o.zh === query.trim() ||
    enFixed === q ||
    enRaw === q ||
    enFixed.replace(/[\s\-_'’]+/g, "") === qClean ||
    enRaw.replace(/[\s\-_'’]+/g, "") === qClean
  );
}

export default function App() {
  const [atlas, setAtlas] = useState<DecodedAtlas | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [originIdx, setOriginIdx] = useState(-1);
  // Staged-file readiness. Each file is merged into the origins in
  // place (object identity is preserved, so a merge never looks like
  // an origin switch to the map), then its flag rebuilds the
  // view-model. Out-map needs no flag: the atlas itself is built from
  // it in phase 1.
  const [outTablesReady, setOutTablesReady] = useState(false);
  const [inMapReady, setInMapReady] = useState(false);
  const [inTablesReady, setInTablesReady] = useState(false);
  const [inMapLoading, setInMapLoading] = useState(false);
  const atlasRef = useRef<DecodedAtlas | null>(null);
  const outTablesRef = useRef<OutTablesData | null>(null);
  const inMapDataRef = useRef<InMapData | null>(null);
  const inTablesRef = useRef<InTablesData | null>(null);
  const flightsRef = useRef({
    outTables: false,
    inMap: false,
    inTables: false,
  });
  const [outline, setOutline] = useState<DecodedOutline | null>(null);
  const [showOutline, setShowOutline] = useState(true);
  const [showNetwork, setShowNetwork] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showInfra, setShowInfraState] = useState<boolean>(initialInfra);
  const [distUnit, setDistUnitState] = useState<DistUnit>(initialDistUnit);
  const [direction, setDirectionState] = useState<Direction>(initialDirection);
  // Pinning a city also filters the table below the map to that city
  // (destinations outbound, sources inbound); the filter lives exactly
  // as long as the panel does.
  const [panelCity, setPanelCity] = useState<CityPointVM | null>(null);
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedHours, setSelectedHours] = useState<number[]>([]);
  const [selectedDistBin, setSelectedDistBin] =
    useState<DistBinFilter | null>(null);
  const [selectedDistBins, setSelectedDistBins] = useState<DistBinFilter[]>([]);
  const [selectedDurBin, setSelectedDurBin] = useState<DurBinFilter | null>(
    null,
  );
  const [selectedDurBins, setSelectedDurBins] = useState<DurBinFilter[]>([]);
  const [selectedTrainCodes, setSelectedTrainCodes] = useState<string[]>([]);
  const [dark, setDarkState] = useState<boolean>(initialDark);
  const [showTimeline] = useState<boolean>(true);
  const [schedulesData, setSchedulesData] = useState<SchedulesData | null>(null);
  const [selectedTrainCode, setSelectedTrainCode] = useState<string | null>(null);
  const [isolatedTrainCode, setIsolatedTrainCode] = useState<string | null>(null);
  const [isTimelineCollapsed, setIsTimelineCollapsed] = useState<boolean>(true);

  const mapRef = useRef<MapApi | null>(null);
  const legendRef = useRef<LegendHandle | null>(null);
  const [initialCamera] = useState(parseInitialCamera);
  const lastCameraRef = useRef<{
    lon: number;
    lat: number;
    zoom: number;
  } | null>(initialCamera);

  const syncUrl = (
    idx: number,
    cam?: { lon: number; lat: number; zoom: number } | null,
  ) => {
    if (!atlasRef.current || idx < 0 || idx >= atlasRef.current.data.origins.length) return;
    const o = atlasRef.current.data.origins[idx];
    const params = new URLSearchParams(window.location.search);
    params.set("city", enName(o.en));
    const camera = cam || lastCameraRef.current;
    if (camera) {
      params.set("lat", camera.lat.toFixed(4));
      params.set("lon", camera.lon.toFixed(4));
      params.set("z", camera.zoom.toFixed(2));
    }
    const newSearch = params.toString();
    const newUrl = `${window.location.pathname}${newSearch ? "?" + newSearch : ""}`;
    if (window.location.search !== `?${newSearch}`) {
      window.history.replaceState(null, "", newUrl);
    }
  };

  const handleViewChange = (v: {
    lon: number;
    lat: number;
    zoom: number;
  }) => {
    lastCameraRef.current = v;
    syncUrl(originIdx, v);
  };

  /* ---------- staged loads (phases 2 and 3) ---------- */
  // Each staged file merges into the origins in place once fetched,
  // then its ready flag rebuilds the view-model. A fetch that beats
  // the atlas (a flip during phase 1) is applied by the init effect
  // instead. Failures clear the in-flight mark and leave the ready
  // flag false; the next direction switch retries.
  const applyOutTables = () => {
    const d = outTablesRef.current;
    const at = atlasRef.current;
    if (!d || !at) return;
    for (let i = 0; i < d.origins.length; i++)
      Object.assign(at.data.origins[i], d.origins[i]);
    setOutTablesReady(true);
  };
  const applyInMap = () => {
    const d = inMapDataRef.current;
    const at = atlasRef.current;
    if (!d || !at) return;
    setInMapLoading(false);
    for (let i = 0; i < d.origins.length; i++)
      Object.assign(at.data.origins[i], d.origins[i]);
    setInMapReady(true);
    // The tables follow the map file, as in every stage.
    ensureInTables();
  };
  const applyInTables = () => {
    const d = inTablesRef.current;
    const at = atlasRef.current;
    if (!d || !at) return;
    for (let i = 0; i < d.origins.length; i++)
      Object.assign(at.data.origins[i], d.origins[i]);
    setInTablesReady(true);
  };

  const ensureOutTables = () => {
    if (outTablesRef.current) {
      applyOutTables();
      return;
    }
    if (flightsRef.current.outTables) return;
    flightsRef.current.outTables = true;
    fetchData<OutTablesData>(OUT_TABLES_URL)
      .then((d) => {
        requireFmt3(d.fmt, OUT_TABLES_URL);
        outTablesRef.current = d;
        flightsRef.current.outTables = false;
        applyOutTables();
      })
      .catch((err: Error) => {
        flightsRef.current.outTables = false;
        setLoadError(err.message);
      });
  };
  const ensureInTables = () => {
    if (inTablesRef.current) {
      applyInTables();
      return;
    }
    if (flightsRef.current.inTables) return;
    flightsRef.current.inTables = true;
    fetchData<InTablesData>(IN_TABLES_URL)
      .then((d) => {
        requireFmt3(d.fmt, IN_TABLES_URL);
        inTablesRef.current = d;
        flightsRef.current.inTables = false;
        applyInTables();
      })
      .catch((err: Error) => {
        flightsRef.current.inTables = false;
        setLoadError(err.message);
      });
  };
  // Phase 3 for inbound: the map file first (paint), and only once it
  // has landed do its tables follow behind it, as in phases 1–2.
  const ensureInMap = () => {
    if (inMapDataRef.current) {
      applyInMap();
      ensureInTables();
      return;
    }
    if (flightsRef.current.inMap) return;
    flightsRef.current.inMap = true;
    setInMapLoading(true);
    fetchData<InMapData>(IN_MAP_URL)
      .then((d) => {
        inMapDataRef.current = d;
        flightsRef.current.inMap = false;
        applyInMap(); // chains the tables fetch once the atlas exists
      })
      .catch(() => {
        flightsRef.current.inMap = false;
        setInMapLoading(false);
      });
  };

  /* ---------- load (phase 1) ---------- */
  useEffect(() => {
    let cancelled = false;
    fetchData<OutlineData>(OUTLINE_URL)
      .then((d) => {
        if (!cancelled) setOutline(prepOutline(d));
      })
      .catch(() => {});
    fetchData<SchedulesData>(SCHEDULES_URL)
      .then((d) => {
        if (!cancelled) setSchedulesData(d);
      })
      .catch((err) => console.warn("Failed to load national schedules asset:", err));
    // A persisted inbound direction paints its map in phase 1 too, so
    // in-map joins the parallel fetch; identity fields still come from
    // out-map, which always loads.
    const persistedIn = initialDirection() === "in";
    const phase1: [
      Promise<SharedData>,
      Promise<OutMapData>,
      Promise<InMapData | null> | null,
    ] = [
      fetchData<SharedData>(SHARED_URL),
      fetchData<OutMapData>(OUT_MAP_URL),
      // A failed in-map fetch must not sink phase 1: it resolves to
      // null here and the staged loader retries it below.
      persistedIn
        ? fetchData<InMapData>(IN_MAP_URL).catch(() => null)
        : null,
    ];
    Promise.all(phase1)
      .then(([shared, outMap, inMap]) => {
        if (cancelled) return;
        const data: AtlasData = {
          ...shared,
          about: ABOUT,
          origins: outMap.origins,
        };
        const decoded = prepAtlas(data);
        atlasRef.current = decoded;
        let def = 0;
        const cityParam = new URLSearchParams(window.location.search).get("city");
        if (cityParam) {
          const match = data.origins.findIndex((o) => matchesCity(o, cityParam));
          if (match >= 0) def = match;
        } else {
          for (let j = 0; j < data.origins.length; j++) {
            if (data.origins[j].zh === "广州") {
              def = j;
              break;
            }
          }
        }
        // Any staged file that beat the atlas here merges in now.
        if (inMap) {
          inMapDataRef.current = inMap;
          applyInMap();
        } else if (inMapDataRef.current) applyInMap();
        if (outTablesRef.current) applyOutTables();
        if (inTablesRef.current) applyInTables();
        setAtlas(decoded);
        setOriginIdx(def);
        syncUrl(def, initialCamera);
        // Phase 2: the active direction's tables go out immediately
        // behind phase 1, no user action needed. (A persisted-inbound
        // session's tables were already chained by applyInMap above;
        // only a failed phase-1 in-map fetch retries, the staged way.)
        if (persistedIn) {
          if (!inMap && !inMapDataRef.current) ensureInMap();
        } else ensureOutTables();
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cur: OriginVM | null = useMemo(
    () => (atlas && originIdx >= 0 ? buildOrigin(atlas, originIdx) : null),
    // The ready flags flip as each staged file merges in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atlas, originIdx, outTablesReady, inMapReady, inTablesReady],
  );

  const viewCur: OriginVM | null = useMemo(
    () =>
      cur
        ? filterOrigin(cur, {
            classes: selectedClasses,
            hours:
              selectedHours.length > 0
                ? selectedHours
                : selectedHour !== null
                  ? [selectedHour]
                  : [],
            distBins:
              selectedDistBins.length > 0
                ? selectedDistBins
                : selectedDistBin
                  ? [selectedDistBin]
                  : [],
            durBins:
              selectedDurBins.length > 0
                ? selectedDurBins
                : selectedDurBin
                  ? [selectedDurBin]
                  : [],
            trainCodes: selectedTrainCodes,
            unit: distUnit,
          })
        : null,
    [
      cur,
      selectedClasses,
      selectedHour,
      selectedHours,
      selectedDistBin,
      selectedDistBins,
      selectedDurBin,
      selectedDurBins,
      selectedTrainCodes,
      distUnit,
    ],
  );

  const selectedTrainVM = useMemo(() => {
    if (!selectedTrainCode || !cur) return null;
    const list = direction === "out" ? cur.deps : cur.arrs;
    return list.find((t) => t.code === selectedTrainCode) || null;
  }, [selectedTrainCode, cur, direction]);

  const availableClasses: Set<string> = useMemo(() => {
    if (!cur) return new Set(FLOW_CLASSES);

    const originClasses = new Set<string>();
    const flows = direction === "out" ? cur.flows : cur.inFlows;
    for (const f of flows) {
      for (let i = 0; i < FLOW_CLASSES.length; i++) {
        if (f.byClass[i] > 0) originClasses.add(FLOW_CLASSES[i]);
      }
    }
    if (direction === "out" && outTablesReady && cur.deps) {
      for (const d of cur.deps) {
        originClasses.add(FLOW_CLASSES[classIndex(d.cls)]);
      }
    } else if (direction === "in" && inTablesReady && cur.arrs) {
      for (const a of cur.arrs) {
        originClasses.add(FLOW_CLASSES[classIndex(a.cls)]);
      }
    }

    if (panelCity) {
      const baseList: CityPointVM[] =
        direction === "out" ? cur.dests : cur.srcs;
      const baseCity = baseList.find((c) => c.idx === panelCity.idx);
      if (direction === "out" && outTablesReady && baseCity) {
        const set = new Set<string>();
        for (const c of (baseCity as DestVM).calls) {
          if (c.dep) set.add(FLOW_CLASSES[classIndex(c.dep.cls)]);
        }
        return set;
      } else if (direction === "in" && inTablesReady && baseCity) {
        const set = new Set<string>();
        for (const c of (baseCity as SrcVM).inCalls) {
          if (c.arr) set.add(FLOW_CLASSES[classIndex(c.arr.cls)]);
        }
        return set;
      }
      return originClasses;
    }

    return originClasses;
  }, [cur, direction, panelCity, outTablesReady, inTablesReady]);

  useEffect(() => {
    setSelectedClasses((prev) => {
      const next = prev.filter((c) => availableClasses.has(c));
      return next.length === prev.length ? prev : next;
    });
  }, [availableClasses]);

  const toggleClass = (cls: string) => {
    setSelectedClasses((prev) =>
      prev.includes(cls) ? prev.filter((c) => c !== cls) : [...prev, cls],
    );
  };

  /* ---------- pinned city follows view-model rebuilds ---------- */
  // Pinning a city keeps that city's view-model object; when a staged
  // merge or class filter rebuilds the current origin, re-point the pin
  // at the fresh object for the same city.
  useEffect(() => {
    if (!viewCur || !panelCity) return;
    const list: CityPointVM[] =
      direction === "out" ? viewCur.dests : viewCur.srcs;
    const fresh = list.find((c) => c.idx === panelCity.idx);
    if (fresh) {
      if (fresh !== panelCity) setPanelCity(fresh);
    } else if (cur && panelCity.trains !== 0) {
      const baseList: CityPointVM[] =
        direction === "out" ? cur.dests : cur.srcs;
      const base = baseList.find((c) => c.idx === panelCity.idx);
      if (base) {
        setPanelCity(
          direction === "out"
            ? ({
                ...(base as import("./types").DestVM),
                trains: 0,
                fast: 0,
                endpoint: 0,
                terminating: 0,
                calls: [],
              } as CityPointVM)
            : ({
                ...(base as import("./types").SrcVM),
                trains: 0,
                fast: 0,
                endpoint: 0,
                originating: 0,
                inCalls: [],
              } as CityPointVM),
        );
      }
    }
  }, [viewCur, cur, panelCity, direction]);

  /* ---------- theme ---------- */
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    try {
      localStorage.removeItem("crfa-theme");
    } catch {
      /* storage unavailable */
    }
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (sessionStorage.getItem("crfa-theme")) return;
      } catch {
        /* storage unavailable */
      }
      setDarkState(e.matches);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
    };
  }, []);

  /* ---------- actions ---------- */
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__mapApi = mapRef.current;
    w.__selectOrigin = (zh: string) => {
      const origins = atlas?.data.origins || [];
      const idx = origins.findIndex((o) => o.zh === zh);
      if (idx >= 0) selectOrigin(idx);
    };
    w.__setShowOutline = setShowOutline;
    w.__setDark = setDark;
  });

  const clearFilters = () => {
    setSelectedClasses([]);
    setSelectedHour(null);
    setSelectedHours([]);
    setSelectedDistBin(null);
    setSelectedDistBins([]);
    setSelectedDurBin(null);
    setSelectedDurBins([]);
    setSelectedTrainCodes([]);
  };

  const selectOrigin = (idx: number) => {
    setPanelCity(null);
    clearFilters();
    setOriginIdx(idx);
    syncUrl(idx);
  };

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const cp = params.get("city");
      if (cp && atlasRef.current) {
        const idx = atlasRef.current.data.origins.findIndex((o) =>
          matchesCity(o, cp),
        );
        if (idx >= 0 && idx !== originIdx) {
          setPanelCity(null);
          setOriginIdx(idx);
        }
      }
      const cam = parseInitialCamera();
      if (cam && mapRef.current) {
        mapRef.current.panZoomTo(cam.lon, cam.lat, cam.scale);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [originIdx]);

  const handleSelectDest = (d: CityPointVM | null) => {
    if (d === null) {
      setPanelCity(null);
      return;
    }
    if (panelCity && panelCity.idx === d.idx) {
      const origins = atlas?.data.origins || [];
      const nextIdx = origins.findIndex((o) => o.zh === d.zh);
      if (nextIdx >= 0) {
        selectOrigin(nextIdx);
        setSelectedClasses([]);
        mapRef.current?.fitCountry();
      } else {
        setPanelCity(null);
      }
    } else {
      setPanelCity(d);
    }
  };

  const closePanel = () => {
    setPanelCity(null);
    if (mapRef.current) mapRef.current.clearStationHover();
  };

  // Switching direction keeps the selected city and re-renders from
  // the other direction's fields; the pinned city and the table's
  // filter/sort state reset (the table remounts on the direction key).
  // The first flip to a direction stages its files: map first (paint),
  // then its tables behind it; flipping back just ensures that
  // direction's tables are on their way.
  const setDirection = (d: Direction) => {
    if (d === direction) return;
    if (d === "in") {
      ensureInMap();
    } else {
      ensureOutTables();
    }
    setPanelCity(null);
    clearFilters();
    setDirectionState(d);
    try {
      if (window.localStorage) localStorage.setItem("crfa-direction", d);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    if (direction === "in") {
      setIsTimelineCollapsed(true);
      setIsolatedTrainCode(null);
      mapRef.current?.setPlaying?.(false);
      mapRef.current?.setAnimEnabled?.(false);
    }
  }, [direction]);

  // Esc dismisses the city panel (and its table filter).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && panelCity) closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCity]);

  // Infrastructure overlay: the proportional flows stay untouched and
  // every flow section's track geometry is superimposed on top of them
  // as one uniform thin line, so the true shape of the rail network
  // reads through the traffic volume; persisted like the direction and
  // distance-unit choices.
  const toggleInfra = () => {
    const v = !showInfra;
    setShowInfraState(v);
    try {
      if (window.localStorage)
        localStorage.setItem("crfa-infra", v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  const setDistUnit = (u: DistUnit) => {
    if (u === distUnit) return;
    setDistUnitState(u);
    try {
      if (window.localStorage) localStorage.setItem("crfa-dist-unit", u);
    } catch {
      /* storage unavailable */
    }
    // The open panel re-renders from state; refresh a visible tooltip too.
    if (mapRef.current) mapRef.current.refreshTooltip();
  };

  const setDark = (d: boolean) => {
    if (d === dark) return;
    setDarkState(d);
    try {
      if (window.sessionStorage)
        sessionStorage.setItem("crfa-theme", d ? "dark" : "light");
      if (window.localStorage) localStorage.removeItem("crfa-theme");
    } catch {
      /* storage unavailable */
    }
  };

  const origins = atlas ? atlas.data.origins : [];

  return (
    <>
      <div className="stage">
        <header>
          <h1>
            <span className="cr-logo-wrap">
              <svg
                className="cr-logo"
                viewBox="-100 -110 200 230"
                aria-hidden="true"
              >
                <path
                  d="M34.899004 68.637159a77 77 0 1 0-69.798007 0l-14.151965 18.506415A100 100 0 0 1-18.99159-98.180036 10 10 0 0 1-10-109.544511a110 110 0 0 1 20 0 10 10 0 0 1 8.99159 11.364475 100 100 0 0 1 30.059378 185.32361zm26.885461 38.719734A4 4 0 0 1 65 111.279216V120H-65v-8.720784a4 4 0 0 1 3.215535-3.922323l42.530091-8.506018A14 14 0 0 0-8 85.122745V28.2573a10 10 0 0 0-7.252789-9.615239L-35 13V-5.169757A14 14 0 0 1-22.105263-19.12606a280 280 0 0 1 44.210526 0A14 14 0 0 1 35-5.169757V13l-19.747211 5.64206A10 10 0 0 0 8 28.2573v56.865445a14 14 0 0 0 11.254373 13.728129z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span>
              China Rail Flow Map <span className="zh">· 铁路客流图</span>
            </span>
          </h1>
          <p className="subtitle">
            Flow diagram of trains departing and arriving across China&rsquo;s
            top rail cities. The width of each line refers to the number of
            daily trains along that particular piece of track &mdash; spanning{" "}
            <b>7,253</b> scheduled daily passenger services (of over{" "}
            <b>12,000</b> nationwide) across China&rsquo;s{" "}
            <b>{distUnit === "mi" ? "30,000 mi" : "48,000 km"}</b> high-speed
            rail network ({distUnit === "mi" ? "100,000 mi" : "162,000 km"} of
            total track).
          </p>
          <div className="stats" id="stats">
            {cur &&
              viewCur &&
              (() => {
                const hasHistFilter =
                  selectedHour !== null ||
                  selectedHours.length > 0 ||
                  selectedDistBin !== null ||
                  selectedDistBins.length > 0 ||
                  selectedDurBin !== null ||
                  selectedDurBins.length > 0 ||
                  selectedTrainCodes.length > 0;
                const hasAnyFilter =
                  selectedClasses.length > 0 || hasHistFilter;
                const filterLabel =
                  selectedTrainCodes.length > 0
                    ? selectedTrainCodes.length === 1
                      ? "train selected"
                      : "trains selected"
                    : "trains matching filter";

                return direction === "out" ? (
                  <>
                    <div>
                      <b>
                        {(hasAnyFilter && outTablesReady
                          ? viewCur.deps.length
                          : cur.o.outbound
                        ).toLocaleString("en-US")}
                      </b>{" "}
                      <span>
                        {hasHistFilter
                          ? filterLabel
                          : selectedClasses.length > 0
                            ? selectedClasses
                                .map((c) => (c === "plain" ? "普" : c))
                                .join("/") +
                              " trains Depart " +
                              cur.en +
                              " daily"
                            : "trains Depart " + cur.en + " daily"}
                      </span>
                    </div>
                    <div>
                      <b>{viewCur.dests.length}</b>{" "}
                      <span>cities with a direct connection</span>
                    </div>
                    <div>
                      <b>{viewCur.maxFlow}</b>{" "}
                      <span>trains/day on the busiest corridors</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <b>
                        {(hasAnyFilter && inTablesReady
                          ? viewCur.arrs.length
                          : cur.o.inbound
                        ).toLocaleString("en-US")}
                      </b>{" "}
                      <span>
                        {hasHistFilter
                          ? filterLabel
                          : selectedClasses.length > 0
                            ? selectedClasses
                                .map((c) => (c === "plain" ? "普" : c))
                                .join("/") +
                              " trains Arrive in " +
                              cur.en +
                              " daily"
                            : "trains Arrive in " + cur.en + " daily"}
                      </span>
                    </div>
                    <div>
                      <b>{viewCur.srcs.length}</b>{" "}
                      <span>cities with a direct connection</span>
                    </div>
                    <div>
                      <b>{viewCur.maxInFlow}</b>{" "}
                      <span>trains/day on the busiest corridors</span>
                    </div>
                  </>
                );
              })()}
          </div>
        </header>

        <div className="toolbar">
          <div className="group city-picker">
            <label htmlFor="originSearch">Origin city</label>
            <CityPicker
              origins={origins}
              curIdx={originIdx}
              onSelect={selectOrigin}
            />
          </div>
          <div className="group units" role="group" aria-label="Direction">
            <button
              id="dirOut"
              type="button"
              aria-pressed={direction === "out" ? "true" : "false"}
              onClick={() => setDirection("out")}
            >
              Outbound
            </button>
            <button
              id="dirIn"
              type="button"
              aria-pressed={direction === "in" ? "true" : "false"}
              onClick={() => setDirection("in")}
            >
              Inbound
            </button>
          </div>
          <div
            className="group cls-filter"
            role="group"
            aria-label="Filter map and table by train class"
          >
            <span className="cls-label">Class:</span>
            <button
              type="button"
              className="cls-btn"
              aria-pressed={selectedClasses.length === 0 ? "true" : "false"}
              onClick={() => setSelectedClasses([])}
            >
              All
            </button>
            {FLOW_CLASSES.map((cls) => {
              const active = selectedClasses.includes(cls);
              const label = cls === "plain" ? "普" : cls;
              const enabled = availableClasses.has(cls);
              return (
                <button
                  key={cls}
                  type="button"
                  className="cls-btn"
                  aria-pressed={active ? "true" : "false"}
                  disabled={!enabled}
                  title={
                    !enabled
                      ? panelCity
                        ? `No ${label} trains between ${cur?.en || "origin"} and ${panelCity.en}`
                        : `No ${label} trains for ${cur?.en || "origin"}`
                      : undefined
                  }
                  onClick={() => toggleClass(cls)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="group">
            <button
              id="btnCountry"
              type="button"
              onClick={() => mapRef.current?.fitCountry()}
            >
              National view
            </button>
            <button
              id="btnHome"
              type="button"
              onClick={() => mapRef.current?.fitHome()}
            >
              Origin close-up
            </button>
          </div>
          <div className="spacer"></div>
          <div className="group">
            <button
              id="tglNetwork"
              type="button"
              aria-pressed={showNetwork ? "true" : "false"}
              onClick={() => setShowNetwork((v) => !v)}
            >
              Rail network
            </button>
            <button
              id="tglLabels"
              type="button"
              aria-pressed={showLabels ? "true" : "false"}
              onClick={() => setShowLabels((v) => !v)}
            >
              City labels
            </button>
            <button
              id="tglInfra"
              type="button"
              aria-pressed={showInfra ? "true" : "false"}
              onClick={toggleInfra}
            >
              Infrastructure
            </button>
            <button
              id="btnOut"
              type="button"
              aria-label="Zoom out"
              onClick={() => mapRef.current?.zoomCenter(1 / 1.45)}
            >
              &minus;
            </button>
            <button
              id="btnIn"
              type="button"
              aria-label="Zoom in"
              onClick={() => mapRef.current?.zoomCenter(1.45)}
            >
              +
            </button>
          </div>
          <div className="group units" role="group" aria-label="Distance units">
            <button
              id="unitKm"
              type="button"
              aria-pressed={distUnit === "km" ? "true" : "false"}
              onClick={() => setDistUnit("km")}
            >
              km
            </button>
            <button
              id="unitMi"
              type="button"
              aria-pressed={distUnit === "mi" ? "true" : "false"}
              onClick={() => setDistUnit("mi")}
            >
              mi
            </button>
          </div>
          <div
            id="themeToggle"
            className="group theme-toggle"
            role="group"
            aria-label="Day or night mode"
          >
            <button
              id="themeDay"
              type="button"
              aria-pressed={!dark ? "true" : "false"}
              onClick={() => setDark(false)}
              title="Day mode"
            >
              Day
            </button>
            <button
              id="themeNight"
              type="button"
              aria-pressed={dark ? "true" : "false"}
              onClick={() => setDark(true)}
              title="Night mode"
            >
              Night
            </button>
          </div>
          <span className="hint">
            Drag to pan &middot; scroll or pinch to zoom &middot; click a city
            for its distances
          </span>
        </div>

        <MapCanvas
          ref={mapRef}
          atlas={atlas}
          outline={outline}
          showOutline={showOutline}
          baseCur={cur}
          cur={viewCur}
          direction={direction}
          dark={dark}
          showNetwork={showNetwork}
          showLabels={showLabels}
          showInfra={showInfra}
          distUnit={distUnit}
          panelDest={panelCity}
          loadError={loadError}
          inLoading={direction === "in" && inMapLoading}
          onSelectDest={handleSelectDest}
          selectedTrainCode={selectedTrainCode}
          onSelectTrain={setSelectedTrainCode}
          isolatedTrainCode={isolatedTrainCode}
          onSelectIsolatedTrain={setIsolatedTrainCode}
          legendRef={legendRef}
          initialCamera={initialCamera}
          onViewChange={handleViewChange}
        >
          {direction === "out" && isolatedTrainCode && (
            <div
              style={{
                position: "absolute",
                top: "16px",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 100,
                background: dark
                  ? "rgba(17, 24, 39, 0.94)"
                  : "rgba(255, 255, 255, 0.95)",
                backdropFilter: "blur(10px)",
                border: "1px solid #F59E0B",
                borderRadius: "30px",
                padding: "6px 16px",
                boxShadow: "0 10px 25px -5px rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                fontSize: "13px",
                color: dark ? "#F3F4F6" : "#111827",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: "#F59E0B",
                  boxShadow: "0 0 8px #F59E0B",
                }}
              />
              <span>
                Isolated:{" "}
                <strong style={{ fontFamily: "monospace", fontWeight: 800 }}>
                  {isolatedTrainCode}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => setSelectedTrainCode(isolatedTrainCode)}
                style={{
                  border: "none",
                  background: dark
                    ? "rgba(255,255,255,0.12)"
                    : "rgba(0,0,0,0.08)",
                  color: "inherit",
                  cursor: "pointer",
                  padding: "3px 8px",
                  borderRadius: "12px",
                  fontSize: "11px",
                  fontWeight: 600,
                }}
              >
                Timetable
              </button>
              <button
                type="button"
                onClick={() => setIsolatedTrainCode(null)}
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: dark ? "#9CA3AF" : "#64748B",
                  fontWeight: 700,
                  fontSize: "14px",
                  padding: "0 4px",
                }}
                title="Exit single train isolation"
              >
                ✕
              </button>
            </div>
          )}
          <ActiveFilterBar
            classes={selectedClasses}
            hours={
              selectedHours.length > 0
                ? selectedHours
                : selectedHour !== null
                  ? [selectedHour]
                  : []
            }
            distBins={
              selectedDistBins.length > 0
                ? selectedDistBins
                : selectedDistBin
                  ? [selectedDistBin]
                  : []
            }
            durBins={
              selectedDurBins.length > 0
                ? selectedDurBins
                : selectedDurBin
                  ? [selectedDurBin]
                  : []
            }
            trainCodes={selectedTrainCodes}
            onClearClass={(cls) =>
              setSelectedClasses((prev) => prev.filter((c) => c !== cls))
            }
            onClearHours={() => {
              setSelectedHours([]);
              setSelectedHour(null);
            }}
            onClearDist={() => {
              setSelectedDistBins([]);
              setSelectedDistBin(null);
            }}
            onClearDur={() => {
              setSelectedDurBins([]);
              setSelectedDurBin(null);
            }}
            onClearTrains={() => setSelectedTrainCodes([])}
            onClearAll={clearFilters}
          />
          <DestinationPanel
            point={panelCity}
            direction={direction}
            cityEn={cur ? cur.en : ""}
            cityZh={cur ? cur.o.zh : ""}
            unit={distUnit}
            onClose={closePanel}
          />
          <div id="legendCol">
            <Legend
              ref={legendRef}
              title={
                direction === "out"
                  ? "Fastest time from origin"
                  : "Fastest time to " + (cur ? cur.en : "destination")
              }
            />
          </div>

          {direction === "out" && isTimelineCollapsed && (
            <div
              style={{
                position: "absolute",
                bottom: "16px",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 30,
                pointerEvents: "auto",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setIsTimelineCollapsed(false);
                  mapRef.current?.setAnimEnabled?.(true);
                  mapRef.current?.setSpeed?.(30);
                  mapRef.current?.setTime?.(360);
                  mapRef.current?.setPlaying?.(true);
                }}
                style={{
                  background: dark ? "#27272A" : "#FFFFFF",
                  color: dark ? "#EDEDEA" : "#111111",
                  border: dark
                    ? "1.5px solid rgba(255, 255, 255, 0.25)"
                    : "1.5px solid #111111",
                  borderRadius: "20px",
                  padding: "6px 20px",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
                  transition: "transform 0.12s ease, background 0.15s ease",
                }}
                title="Expand 24h train flow animation controls"
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#C8302A",
                    boxShadow: "0 0 8px #C8302A",
                  }}
                />
                <span>24h Flow Animation · Expand ▴</span>
              </button>
            </div>
          )}
        </MapCanvas>

        {direction === "out" && showTimeline && !isTimelineCollapsed && (
          <TimelineScrubber
            mapRef={mapRef}
            dark={dark}
            direction={direction}
            originZh={cur?.o.zh}
            onCollapse={() => {
              setIsTimelineCollapsed(true);
              mapRef.current?.setPlaying?.(false);
              mapRef.current?.setAnimEnabled?.(false);
            }}
          />
        )}
      </div>

      <DeparturesTable
        key={direction}
        cur={cur}
        unit={distUnit}
        direction={direction}
        panelCity={panelCity}
        selectedClasses={selectedClasses}
        onSelectClasses={setSelectedClasses}
        outTablesReady={outTablesReady}
        inTablesReady={inTablesReady}
        onClearFilter={() => {
          closePanel();
          setSelectedTrainCodes([]);
        }}
        onSelectTrain={setSelectedTrainCode}
        isolatedTrainCode={isolatedTrainCode}
        onClearTrainIsolation={() => setIsolatedTrainCode(null)}
        onSelectCity={(c) => handleSelectDest(c)}
        selectedHour={selectedHour}
        selectedHours={selectedHours}
        onSelectHour={setSelectedHour}
        onSelectHours={setSelectedHours}
        selectedDistBin={selectedDistBin}
        selectedDistBins={selectedDistBins}
        onSelectDistBin={setSelectedDistBin}
        onSelectDistBins={setSelectedDistBins}
        selectedDurBin={selectedDurBin}
        selectedDurBins={selectedDurBins}
        onSelectDurBin={setSelectedDurBin}
        onSelectDurBins={setSelectedDurBins}
        selectedTrainCodes={selectedTrainCodes}
        onSelectTrainCodes={setSelectedTrainCodes}
      />

      <footer id="pageFooter">
        {atlas ? atlas.data.about : ""}
      </footer>

      <Footnote cur={cur} direction={direction} />

      <TrainScheduleModal
        code={selectedTrainCode}
        trainT={selectedTrainVM ? selectedTrainVM.t : null}
        onClose={() => setSelectedTrainCode(null)}
        schedulesData={schedulesData}
        stationTable={atlas ? atlas.data.station_table : []}
        dark={dark}
        unit={distUnit}
        trainVM={selectedTrainVM}
        isIsolated={isolatedTrainCode === selectedTrainCode}
        onToggleIsolate={(c) => {
          setIsolatedTrainCode((prev) => (prev === c ? null : c));
        }}
        onJumpToTime={(mins) => {
          mapRef.current?.setTime(mins);
        }}
        mapRef={mapRef}
        originCityZh={cur?.o.zh}
        originCityEn={cur?.en}
        direction={direction}
      />
    </>
  );
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function formatHoursLabel(hours: number[]): string {
  if (hours.length === 0) return "";
  if (hours.length === 1) {
    const h = hours[0];
    return `${pad2(h)}:00–${pad2(h + 1)}:00`;
  }
  const sorted = [...hours].sort((a, b) => a - b);
  const isConsecutive = sorted.every(
    (h, i) => i === 0 || h === sorted[i - 1] + 1,
  );
  if (isConsecutive) {
    return `${pad2(sorted[0])}:00–${pad2(sorted[sorted.length - 1] + 1)}:00`;
  }
  return sorted.map((h) => `${pad2(h)}:00`).join(", ");
}

function ActiveFilterBar({
  classes,
  hours,
  distBins,
  durBins,
  trainCodes,
  onClearClass,
  onClearHours,
  onClearDist,
  onClearDur,
  onClearTrains,
  onClearAll,
}: {
  classes: string[];
  hours: number[];
  distBins: DistBinFilter[];
  durBins: DurBinFilter[];
  trainCodes: string[];
  onClearClass: (cls: string) => void;
  onClearHours: () => void;
  onClearDist: () => void;
  onClearDur: () => void;
  onClearTrains: () => void;
  onClearAll: () => void;
}) {
  const hasAny =
    classes.length > 0 ||
    hours.length > 0 ||
    distBins.length > 0 ||
    durBins.length > 0 ||
    trainCodes.length > 0;
  if (!hasAny) return null;

  return (
    <div
      className="active-filter-bar"
      role="status"
      aria-label="Active map and table filters"
    >
      <span className="filter-pill-label">Filtered:</span>
      {classes.map((cls) => (
        <span key={cls} className="filter-pill">
          Class: {cls === "plain" ? "普" : cls}
          <button
            type="button"
            aria-label={`Remove class ${cls} filter`}
            onClick={() => onClearClass(cls)}
          >
            &times;
          </button>
        </span>
      ))}
      {trainCodes.length > 0 && (
        <span className="filter-pill">
          {trainCodes.length === 1
            ? `Train: ${trainCodes[0]}`
            : `Trains: ${trainCodes.length} selected`}
          <button
            type="button"
            aria-label="Remove train selection"
            onClick={onClearTrains}
          >
            &times;
          </button>
        </span>
      )}
      {hours.length > 0 && (
        <span className="filter-pill">
          {hours.length === 1 ? "Hour" : "Hours"}: {formatHoursLabel(hours)}
          <button
            type="button"
            aria-label="Remove hour filter"
            onClick={onClearHours}
          >
            &times;
          </button>
        </span>
      )}
      {distBins.length > 0 && (
        <span className="filter-pill">
          Dist: {distBins.map((b) => b.label).join(", ")}
          <button
            type="button"
            aria-label="Remove distance filter"
            onClick={onClearDist}
          >
            &times;
          </button>
        </span>
      )}
      {durBins.length > 0 && (
        <span className="filter-pill">
          Time: {durBins.map((b) => b.label).join(", ")}
          <button
            type="button"
            aria-label="Remove duration filter"
            onClick={onClearDur}
          >
            &times;
          </button>
        </span>
      )}
      <button
        type="button"
        className="filter-clear-all"
        onClick={onClearAll}
        title="Reset all filters"
      >
        Reset
      </button>
    </div>
  );
}
