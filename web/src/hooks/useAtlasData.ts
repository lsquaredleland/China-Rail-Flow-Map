import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  AtlasData,
  DecodedAtlas,
  DecodedOutline,
  InMapData,
  InTablesData,
  InTablesPack,
  NationalFlowsPack,
  OutMapData,
  OutTablesData,
  OutTablesPack,
  OutTablesRaw,
  OutlineData,
  SchedulesData,
  SharedData,
} from "../types";
import {
  expandInTables,
  expandOutTables,
  prepAtlas,
  prepOutline,
  requireFmt,
  requireNationalFlows,
} from "../lib";
import {
  ABOUT,
  IN_MAP_URL,
  IN_TABLES_URL,
  NATIONAL_FLOWS_URL,
  OUTLINE_URL,
  OUT_TABLES_URL,
  SCHEDULES_URL,
  SHARED_URL,
  fetchData,
  fetchInMap,
  fetchOutMap,
} from "../data";
import { initialDirection, matchesCity } from "./useUrlState";

/* Staged data loading (see the phase notes in ../data.ts). Each staged
   file merges into the origins in place once fetched (object identity is
   preserved, so a merge never looks like an origin switch to the map),
   then its ready flag flips so the view-model rebuilds. Out-map needs no
   flag: the atlas itself is built from it in phase 1. */
export function useAtlasData({
  atlasRef,
  selectedTrainCode,
  onReady,
}: {
  atlasRef: RefObject<DecodedAtlas | null>;
  /** The open schedule modal asks for the schedules asset. */
  selectedTrainCode: string | null;
  /** The atlas is built; `defaultIdx` is the origin to start on. */
  onReady: (defaultIdx: number) => void;
}) {
  const [atlas, setAtlas] = useState<DecodedAtlas | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outline, setOutline] = useState<DecodedOutline | null>(null);
  const [outTablesReady, setOutTablesReady] = useState(false);
  // The path tables as shipped, kept for the national timelines (the
  // per-origin parts are expanded and merged, then dropped).
  const [outTablesRaw, setOutTablesRaw] = useState<OutTablesRaw | null>(null);
  const [inMapReady, setInMapReady] = useState(false);
  const [inTablesReady, setInTablesReady] = useState(false);
  const [inMapLoading, setInMapLoading] = useState(false);
  const [schedulesData, setSchedulesData] = useState<SchedulesData | null>(null);
  // National per-section flows (P3.2): only national mode asks for them.
  const [nationalFlows, setNationalFlows] = useState<NationalFlowsPack | null>(null);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // The loader owns the in-flight marks and the fetched-but-not-yet-merged
  // packs. Everything it touches is a ref or a state setter, so it is built
  // once and stays valid for the whole session.
  const loader = useMemo(() => {
    const outTablesRef: { current: OutTablesData | null } = { current: null };
    const inMapDataRef: { current: InMapData | null } = { current: null };
    const inTablesRef: { current: InTablesData | null } = { current: null };
    const nationalFlowsRef: { current: NationalFlowsPack | null } = { current: null };
    // The schedules asset (O16): not part of first paint. It is fetched once, in
    // parallel with the out tables, which wait for it so every timeline is
    // built with station-level stops (null if it failed to load); an opened
    // schedule modal also requests it.
    let schedulesPromise: Promise<SchedulesData | null> | null = null;
    let schedData: SchedulesData | null = null;
    const flights = { outTables: false, inMap: false, inTables: false, nationalFlows: false };

    const loadSchedules = () => {
      if (!schedulesPromise) {
        schedulesPromise = fetchData<SchedulesData>(SCHEDULES_URL).catch((err) => {
          console.warn("Failed to load national schedules asset:", err);
          return null;
        });
      }
      return schedulesPromise;
    };

    /* ---------- staged loads (phases 2 and 3) ----------
       A fetch that beats the atlas (a flip during phase 1) is applied by
       the init effect instead. Failures clear the in-flight mark and leave
       the ready flag false; the next direction switch retries. */
    const applyOutTables = () => {
      const d = outTablesRef.current;
      const at = atlasRef.current;
      if (!d || !at) return;
      if (schedData) at.schedules = schedData.schedules;
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
      if (flights.outTables) return;
      flights.outTables = true;
      Promise.all([fetchData<OutTablesPack>(OUT_TABLES_URL), loadSchedules()])
        .then(([d, sched]) => {
          requireFmt(d.fmt, OUT_TABLES_URL);
          schedData = sched;
          if (sched) setSchedulesData(sched);
          outTablesRef.current = expandOutTables(d);
          setOutTablesRaw({ paths: d.paths, stop_pos: d.stop_pos, chords: d.chords });
          flights.outTables = false;
          setLoadError((e) => (e && e.startsWith(OUT_TABLES_URL) ? null : e));
          applyOutTables();
        })
        .catch((err: Error) => {
          flights.outTables = false;
          // Only a wrong data format blocks the map; a failed fetch leaves
          // it usable (the table keeps its loading note), as on main.
          if (err.name === "FmtError") setLoadError(err.message);
        });
    };
    const ensureInTables = () => {
      if (inTablesRef.current) {
        applyInTables();
        return;
      }
      if (flights.inTables) return;
      flights.inTables = true;
      fetchData<InTablesPack>(IN_TABLES_URL)
        .then((d) => {
          requireFmt(d.fmt, IN_TABLES_URL);
          inTablesRef.current = expandInTables(d);
          flights.inTables = false;
          setLoadError((e) => (e && e.startsWith(IN_TABLES_URL) ? null : e));
          applyInTables();
        })
        .catch((err: Error) => {
          flights.inTables = false;
          if (err.name === "FmtError") setLoadError(err.message);
        });
    };
    // National flows: on request only, never part of the origin view's
    // loads. The arrays index the shared sections, so they are checked
    // against the atlas once both exist.
    const applyNationalFlows = () => {
      const d = nationalFlowsRef.current;
      const at = atlasRef.current;
      if (!d || !at) return;
      try {
        requireNationalFlows(d, at.data.sections.length, NATIONAL_FLOWS_URL);
      } catch (err) {
        nationalFlowsRef.current = null;
        setLoadError((err as Error).message);
        return;
      }
      setNationalFlows(d);
    };
    const ensureNationalFlows = () => {
      if (nationalFlowsRef.current) {
        applyNationalFlows();
        return;
      }
      if (flights.nationalFlows) return;
      flights.nationalFlows = true;
      fetchData<NationalFlowsPack>(NATIONAL_FLOWS_URL)
        .then((d) => {
          requireFmt(d.fmt, NATIONAL_FLOWS_URL);
          nationalFlowsRef.current = d;
          flights.nationalFlows = false;
          setLoadError((e) => (e && e.startsWith(NATIONAL_FLOWS_URL) ? null : e));
          applyNationalFlows();
        })
        .catch((err: Error) => {
          flights.nationalFlows = false;
          if (err.name === "FmtError") setLoadError(err.message);
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
      if (flights.inMap) return;
      flights.inMap = true;
      setInMapLoading(true);
      fetchInMap()
        .then((d) => {
          inMapDataRef.current = d;
          flights.inMap = false;
          applyInMap(); // chains the tables fetch once the atlas exists
        })
        .catch((err: Error) => {
          flights.inMap = false;
          setInMapLoading(false);
          if (err.name === "FmtError") setLoadError(err.message);
        });
    };

    return {
      loadSchedules,
      ensureOutTables,
      ensureInMap,
      ensureInTables,
      ensureNationalFlows,
      /** Phase 1 finished: merge any staged file that beat the atlas. */
      mergeEarly(inMap: InMapData | null) {
        if (inMap) {
          inMapDataRef.current = inMap;
          applyInMap();
        } else if (inMapDataRef.current) applyInMap();
        if (outTablesRef.current) applyOutTables();
        if (inTablesRef.current) applyInTables();
        if (nationalFlowsRef.current) applyNationalFlows();
      },
      hasInMap: () => !!inMapDataRef.current,
    };
  }, [atlasRef]);

  useEffect(() => {
    if (selectedTrainCode === null) return;
    let live = true;
    loader.loadSchedules().then((d) => {
      if (live && d) setSchedulesData(d);
    });
    return () => {
      live = false;
    };
  }, [loader, selectedTrainCode]);

  /* ---------- load (phase 1) ---------- */
  useEffect(() => {
    let cancelled = false;
    fetchData<OutlineData>(OUTLINE_URL)
      .then((d) => {
        if (!cancelled) setOutline(prepOutline(d));
      })
      .catch(() => {});
    // A persisted inbound direction paints its map in phase 1 too, so
    // in-map joins the parallel fetch; identity fields still come from
    // out-map, which always loads.
    const persistedIn = initialDirection() === "in";
    const phase1: [
      Promise<SharedData>,
      Promise<OutMapData>,
      Promise<InMapData | null> | null,
    ] = [
      fetchData<SharedData>(SHARED_URL).then((d) => {
        requireFmt(d.fmt, SHARED_URL);
        return d;
      }),
      fetchOutMap(),
      // A failed in-map fetch must not sink phase 1: it resolves to
      // null here and the staged loader retries it below.
      persistedIn ? fetchInMap().catch(() => null) : null,
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
        loader.mergeEarly(inMap);
        setAtlas(decoded);
        onReadyRef.current(def);
        // Phase 2: the active direction's tables go out immediately
        // behind phase 1, no user action needed. (A persisted-inbound
        // session's tables were already chained by applyInMap above;
        // only a failed phase-1 in-map fetch retries, the staged way.)
        if (persistedIn) {
          if (!inMap && !loader.hasInMap()) loader.ensureInMap();
        } else loader.ensureOutTables();
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [atlasRef, loader]);

  return {
    atlas,
    outline,
    loadError,
    outTablesReady,
    outTablesRaw,
    inMapReady,
    inTablesReady,
    inMapLoading,
    schedulesData,
    nationalFlows,
    ensureOutTables: loader.ensureOutTables,
    ensureInMap: loader.ensureInMap,
    ensureNationalFlows: loader.ensureNationalFlows,
  };
}
