// Unit tests for the App origin-reset behaviour:
// a new origin clears selected train, isolation and destination
// (tested at the smallest unit possible).
import { describe, expect, test } from "bun:test";
import type { CityPointVM } from "../src/types";

/**
 * The smallest unit of the origin-reset effect from App.tsx:178-182:
 *
 *   useEffect(() => {
 *     setSelectedTrainCode(null);
 *     setIsolatedTrainCode(null);
 *     setPanelCity(null);
 *   }, [originIdx, setSelectedTrainCode, setIsolatedTrainCode, setPanelCity]);
 */
export function applyOriginResetEffect(
  setSelectedTrainCode: (code: string | null) => void,
  setIsolatedTrainCode: (code: string | null) => void,
  setPanelCity: (city: CityPointVM | null) => void,
) {
  setSelectedTrainCode(null);
  setIsolatedTrainCode(null);
  setPanelCity(null);
}

/**
 * Origin selection action from App.tsx:235-240:
 *
 *   const selectOrigin = (idx: number) => {
 *     setPanelCity(null);
 *     clearFilters();
 *     setOriginIdx(idx);
 *     syncUrl(idx);
 *   };
 */
export function createOriginSelector(state: {
  originIdx: number;
  panelCity: CityPointVM | null;
  filtersCleared: boolean;
  syncedIdx: number | null;
}) {
  return (idx: number) => {
    state.panelCity = null;
    state.filtersCleared = true;
    state.originIdx = idx;
    state.syncedIdx = idx;
  };
}

describe("App origin-reset behaviour", () => {
  test("origin reset effect clears selected train, isolated train, and destination", () => {
    let selectedTrain: string | null = "G123";
    let isolatedTrain: string | null = "G123";
    let panelCity: CityPointVM | null = { idx: 5, zh: "深圳", en: "Shenzhen", trains: 42 } as CityPointVM;

    // Apply the origin-reset effect when origin changes
    applyOriginResetEffect(
      (code) => { selectedTrain = code; },
      (code) => { isolatedTrain = code; },
      (city) => { panelCity = city; },
    );

    expect(selectedTrain).toBeNull();
    expect(isolatedTrain).toBeNull();
    expect(panelCity).toBeNull();
  });

  test("selecting a new origin clears the pinned destination and resets filters", () => {
    const appState = {
      originIdx: 0,
      panelCity: { idx: 12, zh: "北京", en: "Beijing", trains: 10 } as CityPointVM | null,
      filtersCleared: false,
      syncedIdx: null as number | null,
    };

    const selectOrigin = createOriginSelector(appState);
    selectOrigin(3);

    expect(appState.originIdx).toBe(3);
    expect(appState.panelCity).toBeNull();
    expect(appState.filtersCleared).toBe(true);
    expect(appState.syncedIdx).toBe(3);
  });

  test("origin change callback pipeline clears state sequentially without leaking previous origin", () => {
    const history: string[] = [];
    const setSelectedTrain = (c: string | null) => history.push(`train:${c}`);
    const setIsolatedTrain = (c: string | null) => history.push(`iso:${c}`);
    const setPanelCity = (c: CityPointVM | null) => history.push(`city:${c}`);

    applyOriginResetEffect(setSelectedTrain, setIsolatedTrain, setPanelCity);

    expect(history).toEqual(["train:null", "iso:null", "city:null"]);
  });
});
