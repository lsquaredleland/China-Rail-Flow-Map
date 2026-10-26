// Unit tests for Histograms: rendering bins/rows (both origin and national)
// and click-to-filter callbacks.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Histograms, { Chart } from "../src/components/Histograms";
import type { HistRow } from "../src/lib";
import { origin } from "./fixture";

describe("Histograms component", () => {
  test("renders 3 figures for outbound departures", () => {
    const rows: HistRow[] = [
      { time: "08:15", distKm: 120, dur: 45, cls: "G" },
      { time: "08:45", distKm: 300, dur: 90, cls: "G" },
      { time: "14:00", distKm: 1200, dur: 360, cls: "D" },
      { time: "20:30", distKm: 2100, dur: 600, cls: "K" },
    ];
    const h = renderToStaticMarkup(
      <Histograms rows={rows} where="Guangzhou" unit="km" direction="out" />
    );
    expect(h).toContain("Departures by hour");
    expect(h).toContain("Trains by journey distance");
    expect(h).toContain("Trains by journey time");
    expect(h).toContain("Click a bar to filter");
    expect(h).toContain("role=\"img\"");
    expect(h).toContain("busiest hour is");
  });

  test("renders arrivals histogram for inbound direction", () => {
    const rows: HistRow[] = [
      { time: "09:30", distKm: 350, dur: 120, cls: "G" },
      { time: "15:45", distKm: 800, dur: 300, cls: "D" },
    ];
    const h = renderToStaticMarkup(
      <Histograms rows={rows} where="Guangzhou" unit="km" direction="in" />
    );
    expect(h).toContain("Arrivals by hour");
    expect(h).toContain("Trains by journey distance");
    expect(h).toContain("Trains by journey time");
  });

  test("renders national mode when fed rows directly without cur", () => {
    const rows: HistRow[] = [
      { time: "08:15", distKm: 120, dur: 45, cls: "G" },
      { time: "08:45", distKm: 300, dur: 90, cls: "G" },
      { time: "14:00", distKm: 1200, dur: 360, cls: "D" },
      { time: "20:30", distKm: 2100, dur: 600, cls: "K" },
    ];
    const h = renderToStaticMarkup(
      <Histograms rows={rows} where="China" unit="km" direction="out" />
    );
    expect(h).toContain("Departures by hour");
    expect(h).toContain("Trains by journey distance");
    expect(h).toContain("Trains by journey time");
    // 08:00–09:00 bin has 2 trains (the peak hour)
    expect(h).toContain("busiest hour is 08:00 with 2 trains");
    expect(h).toContain("08:00–09:00 · 2 trains");
  });

  test("active filters mark bins as selected and dimmed", () => {
    const rows: HistRow[] = [
      { time: "08:15", distKm: 100, dur: 60, cls: "G" },
      { time: "12:00", distKm: 200, dur: 120, cls: "D" },
    ];
    const h = renderToStaticMarkup(
      <Histograms
        rows={rows}
        where="China"
        unit="km"
        direction="out"
        selectedHour={8}
      />
    );
    expect(h).toContain("is-selected");
    expect(h).toContain("is-dimmed");
    expect(h).toContain("Click to clear filter");
  });

  test("class filter filters the rows", () => {
    const rows: HistRow[] = [
      { time: "08:00", distKm: 100, dur: 60, cls: "G" },
      { time: "08:30", distKm: 100, dur: 60, cls: "D" },
    ];
    const all = renderToStaticMarkup(
      <Histograms rows={rows} where="China" unit="km" direction="out" />
    );
    expect(all).toContain("08:00–09:00 · 2 trains");

    const gOnly = renderToStaticMarkup(
      <Histograms rows={rows} where="China" unit="km" direction="out" selectedClasses={["G"]} />
    );
    // Sub-bar / filtered count indicates 1 G train out of 2 total
    expect(gOnly).toContain("1 G (of 2 trains)");
  });
});

describe("Chart click-to-filter callback", () => {
  test("clickable bins receive onClick and fire callback with bin index", () => {
    let clickedBin = -1;
    let clickedEvent: any = null;

    let captured: any;
    function TestWrapper() {
      captured = Chart({
        counts: [5, 0, 12],
        ticks: [],
        titles: ["0–1", "1–2", "2–3"],
        barClass: "bar-h",
        ariaLabel: "test chart",
        onSelectBin: (bin, e) => {
          clickedBin = bin;
          clickedEvent = e;
        },
      });
      return null;
    }

    renderToStaticMarkup(<TestWrapper />);

    // captured is <svg ...>{[ [<g ...>, <g ...>, <g ...>], ... ]}</svg>
    const cols = captured.props.children[0];
    expect(cols).toHaveLength(3);

    // Bin 0 has count 5 -> clickable
    expect(cols[0].props.className).toContain("clickable");
    expect(typeof cols[0].props.onClick).toBe("function");

    // Bin 1 has count 0 and not selected -> not clickable
    expect(cols[1].props.className).not.toContain("clickable");
    expect(cols[1].props.onClick).toBeUndefined();

    // Bin 2 has count 12 -> clickable
    expect(cols[2].props.className).toContain("clickable");

    // Click bin 2
    const fakeEv = { type: "click" };
    cols[2].props.onClick(fakeEv);
    expect(clickedBin).toBe(2);
    expect(clickedEvent).toBe(fakeEv);
  });

  test("selected bin with count 0 is still clickable to clear filter", () => {
    let clickedBin = -1;
    let captured: any;
    function TestWrapper() {
      captured = Chart({
        counts: [0, 0],
        ticks: [],
        titles: ["0–1", "1–2"],
        barClass: "bar-h",
        selectedBin: 1,
        ariaLabel: "test chart",
        onSelectBin: (bin) => {
          clickedBin = bin;
        },
      });
      return null;
    }

    renderToStaticMarkup(<TestWrapper />);
    const cols = captured.props.children[0];
    expect(cols[1].props.className).toContain("clickable");
    expect(cols[1].props.className).toContain("is-selected");
    cols[1].props.onClick({});
    expect(clickedBin).toBe(1);
  });
});
