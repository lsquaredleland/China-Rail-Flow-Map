// Unit tests for DeparturesTable modes:
// out, in, and national render the right heading and row count for small fixtures.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import DeparturesTable from "../src/components/DeparturesTable";
import type { NatData } from "../src/components/departures/types";
import { origin, pack } from "./fixture";

describe("DeparturesTable modes", () => {
  const o = origin("广州");
  const { atlas } = pack();

  const baseProps = {
    unit: "km" as const,
    panelCity: null,
    selectedClasses: [],
    onSelectClasses: () => {},
    outTablesReady: true,
    inTablesReady: true,
    onClearFilter: () => {},
    atlas,
  };

  test("outbound mode: renders correct heading and row count from origin deps", () => {
    const h = renderToStaticMarkup(
      <DeparturesTable
        {...baseProps}
        cur={o}
        direction="out"
      />
    );
    expect(h).toContain("Departures from");
    expect(h).toContain("Guangzhou · 广州");
    expect(h).toContain(`<b class="dep-num-lead">${o.deps.length}</b>`);
    expect(h).toContain('id="depBody"');
    expect(h).toContain("train-cell");
  });

  test("outbound mode while tables loading: shows loading section without table body", () => {
    const h = renderToStaticMarkup(
      <DeparturesTable
        {...baseProps}
        cur={o}
        direction="out"
        outTablesReady={false}
      />
    );
    expect(h).toContain("Departures from");
    expect(h).toContain("Loading the train tables");
    expect(h).not.toContain('id="depBody"');
  });

  test("outbound mode with class filter: heading reflects class tag and filtered count", () => {
    const dCount = o.deps.filter((d) => d.cls === "D").length;
    const h = renderToStaticMarkup(
      <DeparturesTable
        {...baseProps}
        cur={o}
        direction="out"
        selectedClasses={["D"]}
      />
    );
    expect(h).toContain("D departures from");
    expect(h).toContain(`<b class="dep-num-lead">${dCount}</b>`);
    expect(h).toContain(`of ${o.deps.length}`);
  });

  test("inbound mode: renders correct heading and count for inbound arrivals", () => {
    const arrs = [
      { cls: "G", code: "G101", tsZh: "北京", tsEn: "Beijing", hay: "", dep: "08:00", arr: "12:00", dur: 240, distKm: 1200 },
      { cls: "D", code: "D201", tsZh: "上海", tsEn: "Shanghai", hay: "", dep: "09:00", arr: "15:00", dur: 360, distKm: 1500 },
    ];
    const inOrigin = { ...o, arrs } as any;

    const h = renderToStaticMarkup(
      <DeparturesTable
        {...baseProps}
        cur={inOrigin}
        direction="in"
      />
    );
    expect(h).toContain("Arrivals in");
    expect(h).toContain("Guangzhou · 广州");
    expect(h).toContain(`<b class="dep-num-lead">${arrs.length}</b>`);
    expect(h).toContain("<b>101</b>");
    expect(h).toContain("<b>201</b>");
  });

  test("national mode: renders All trains of China Rail heading and national count", () => {
    const list = [
      { t: 0, code: "G1", oZh: "北京", dZh: "上海", oEn: "Beijing", dEn: "Shanghai", depMins: 480, arrMins: 720, durMins: 240, distKm: 1318, cls: "G", runsZh: "每日", runsEn: "Daily", hay: "" },
      { t: 1, code: "D2", oZh: "广州", dZh: "深圳", oEn: "Guangzhou", dEn: "Shenzhen", depMins: 600, arrMins: 640, durMins: 40, distKm: 140, cls: "D", runsZh: "每日", runsEn: "Daily", hay: "" },
    ];
    const natData: NatData = {
      list,
      rows: list as any,
      histRows: list.map((r) => ({ time: "08:00", distKm: r.distKm, dur: r.durMins, cls: r.cls })),
      rawCount: list.length,
      cityIndex: null,
      trainTable: atlas.data.train_table,
    };

    const h = renderToStaticMarkup(
      <DeparturesTable
        {...baseProps}
        cur={null}
        national={natData}
        direction="out"
      />
    );
    expect(h).toContain("All trains of");
    expect(h).toContain("China Rail");
    expect(h).toContain(`<b class="dep-num-lead">${list.length}</b>`);
    expect(h).toContain("dep-scroll");
  });
});
