// The collapsed map cards: city card (origin and national wording) and the
// train card with its honest states.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CityCard, TrainCard, cardStName } from "../src/components/MapCards";

const noop = () => {};

describe("CityCard", () => {
  test("origin: from line, bold count, Details and close", () => {
    const h = renderToStaticMarkup(
      <CityCard en="Shanghai" zh="上海" sub="from Chongqing" count={20} onExpand={noop} onClose={noop} />,
    );
    expect(h).toContain("Shanghai 上海");
    expect(h).toContain("from Chongqing");
    expect(h).toContain("<b>20</b> trains");
    expect(h).toContain("Details");
    expect(h).toContain('aria-label="Close city details"');
  });
  test("national: no origin, departures and arrivals", () => {
    const h = renderToStaticMarkup(
      <CityCard en="Wuhan" zh="武汉" sub="120 departures · 98 arrivals" onExpand={noop} onClose={noop} />,
    );
    expect(h).toContain("120 departures · 98 arrivals");
    expect(h).not.toContain("from ");
  });
});

describe("TrainCard", () => {
  const card = (state: "en-route" | "not-departed" | "arrived", leg = "") =>
    renderToStaticMarkup(
      <TrainCard
        code="D351"
        route="重庆北 Chongqing North → 上海 Shanghai"
        state={state}
        leg={leg}
        band="#E3A63F"
        onTimetable={noop}
        onClose={noop}
        closeLabel="Close timetable"
        ariaLabel="Train D351"
      />,
    );
  test("splits class letter and number, shows the band colour", () => {
    const h = card("en-route", "枝江北 → 荆州");
    expect(h).toContain('class="mc-class">D<');
    expect(h).toContain('class="mc-num">351<');
    expect(h).toContain("background:#E3A63F");
    expect(h).toContain("Timetable");
    expect(h).toContain("En route");
  });
  test("honest states replace En route", () => {
    expect(card("not-departed", "departs 07:30")).toContain("Not yet departed");
    expect(card("arrived", "上海")).toContain("Arrived");
    expect(card("arrived")).not.toContain("En route");
  });
  test("station names dedupe identical zh/en", () => {
    expect(cardStName("重庆北", "Chongqing North")).toBe("重庆北 Chongqing North");
    expect(cardStName("北京", "北京")).toBe("北京");
  });
});
