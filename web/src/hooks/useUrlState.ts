import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { local as localStore, session as sessionStore } from "../storage";
import type { DecodedAtlas, Direction, DistUnit } from "../types";
import { enName } from "../lib";
import type { MapApi } from "../components/MapCanvas";

/* URL and persisted state: the ?city/lat/lon/z/theme query, and the
   direction, unit, infrastructure and theme choices kept in storage. */

export interface Camera {
  lon: number;
  lat: number;
  zoom: number;
}

export function initialDistUnit(): DistUnit {
  return localStore.get("crfa-dist-unit") === "mi" ? "mi" : "km";
}

export function initialInfra(): boolean {
  return localStore.get("crfa-infra") === "1";
}

export function initialDirection(): Direction {
  return localStore.get("crfa-direction") === "in" ? "in" : "out";
}

export function initialDark(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("theme");
    if (p === "dark" || p === "night") return true;
    if (p === "light" || p === "day") return false;
    const saved = sessionStore.get("crfa-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
  } catch {
    /* unparseable URL */
  }
  return !!(
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function parseInitialCamera(): (Camera & { scale: number }) | null {
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

export function matchesCity(o: { zh: string; en: string }, query: string): boolean {
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

/* Direction, distance unit, infrastructure overlay and day/night theme:
   initial values come from storage / the URL, each setter persists. */
export function usePrefs() {
  const [showInfra, setShowInfraState] = useState<boolean>(initialInfra);
  const [distUnit, setDistUnitState] = useState<DistUnit>(initialDistUnit);
  const [direction, setDirectionState] = useState<Direction>(initialDirection);
  const [dark, setDarkState] = useState<boolean>(initialDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    localStore.remove("crfa-theme");
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      if (sessionStore.get("crfa-theme")) return;
      setDarkState(e.matches);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
    };
  }, []);

  // Infrastructure overlay: the proportional flows stay untouched and
  // every flow section's track geometry is superimposed on top of them
  // as one uniform thin line, so the true shape of the rail network
  // reads through the traffic volume; persisted like the direction and
  // distance-unit choices.
  const toggleInfra = () => {
    const v = !showInfra;
    setShowInfraState(v);
    localStore.set("crfa-infra", v ? "1" : "0");
  };

  const setDistUnit = (u: DistUnit) => {
    setDistUnitState(u);
    localStore.set("crfa-dist-unit", u);
  };

  const setDirection = (d: Direction) => {
    setDirectionState(d);
    localStore.set("crfa-direction", d);
  };

  const setDark = (d: boolean) => {
    if (d === dark) return;
    setDarkState(d);
    sessionStore.set("crfa-theme", d ? "dark" : "light");
    localStore.remove("crfa-theme");
  };

  return {
    showInfra,
    toggleInfra,
    distUnit,
    setDistUnit,
    direction,
    setDirection,
    dark,
    setDark,
  };
}

/* Keeps ?city=&lat=&lon=&z= in step with the selected origin and the
   camera (history.replaceState), and follows back/forward navigation. */
export function useUrlSync({
  atlasRef,
  mapRef,
  originIdx,
  onCityFromUrl,
}: {
  atlasRef: RefObject<DecodedAtlas | null>;
  mapRef: RefObject<MapApi | null>;
  originIdx: number;
  /** Browser back/forward landed on another city. */
  onCityFromUrl: (idx: number) => void;
}) {
  const [initialCamera] = useState(parseInitialCamera);
  const lastCameraRef = useRef<Camera | null>(initialCamera);

  const syncUrl = (idx: number, cam?: Camera | null) => {
    const atlas = atlasRef.current;
    if (!atlas || idx < 0 || idx >= atlas.data.origins.length) return;
    const o = atlas.data.origins[idx];
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

  const handleViewChange = (v: Camera) => {
    lastCameraRef.current = v;
    syncUrl(originIdx, v);
  };

  // The handler reads the latest callback through a ref, so the listener
  // only re-subscribes when the selected origin changes.
  const onCityRef = useRef(onCityFromUrl);
  onCityRef.current = onCityFromUrl;
  const onPopState = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    const cp = params.get("city");
    if (cp && atlasRef.current) {
      const idx = atlasRef.current.data.origins.findIndex((o) =>
        matchesCity(o, cp),
      );
      if (idx >= 0 && idx !== originIdx) onCityRef.current(idx);
    }
    const cam = parseInitialCamera();
    if (cam && mapRef.current) {
      mapRef.current.panZoomTo(cam.lon, cam.lat, cam.scale);
    }
  }, [atlasRef, mapRef, originIdx]);
  useEffect(() => {
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onPopState]);

  return { initialCamera, syncUrl, handleViewChange };
}
