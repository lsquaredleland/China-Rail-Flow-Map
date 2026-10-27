import type { ReactNode } from "react";
import type { DestVM, Direction, OriginVM, SrcVM } from "../../types";

/* The section shell shown while the active direction's per-train tables
   are still in flight: heading and note from map-file aggregates over a
   loading line. */
export default function LoadingSection({
  cur,
  direction,
  destFilter,
  srcFilter,
}: {
  cur: OriginVM;
  direction: Direction;
  destFilter: DestVM | null;
  srcFilter: SrcVM | null;
}) {
  let heading: ReactNode;
  let note: ReactNode;
  if (destFilter) {
    heading = (
      <>
        <span id="depCityName">
          {destFilter.trains} trains call at {destFilter.en} &middot;{" "}
          {destFilter.zh}
        </span>{" "}
        &mdash;{" "}
        <span id="depCount">
          {destFilter.terminating > 0
            ? destFilter.terminating + " terminate here"
            : "none terminate here — all intermediate stops"}
        </span>
      </>
    );
    note = (
      <>
        Every train from {cur.en} that stops at {destFilter.en} &mdash;
        whether it ends its journey there or only calls on the way
        through. &ldquo;Arrives&rdquo; and &ldquo;Departs&rdquo; are the
        times at {destFilter.en}&rsquo;s station; &ldquo;Final
        destination&rdquo; is where the train is ultimately bound.
      </>
    );
  } else if (srcFilter) {
    heading = (
      <>
        <span id="depCityName">
          {srcFilter.trains} trains arrive from {srcFilter.en} &middot;{" "}
          {srcFilter.zh}
        </span>{" "}
        &mdash;{" "}
        <span id="depCount">
          {srcFilter.originating > 0
            ? srcFilter.originating + " start there"
            : "none start there"}
        </span>
      </>
    );
    note = (
      <>
        Every train from {srcFilter.en} that arrives in {cur.en} &mdash;
        whether it starts in {srcFilter.en} or only calls there on the
        way in. &ldquo;Departs {srcFilter.en}&rdquo; is the boarding time
        at {srcFilter.en}&rsquo;s station; &ldquo;Origin&rdquo; is where
        the train truly starts.
      </>
    );
  } else if (direction === "in") {
    heading = (
      <>
        Arrivals into{" "}
        <span id="depCityName">
          {cur.en} &middot; {cur.o.zh}
        </span>{" "}
        &mdash; <span id="depCount">{cur.o.inbound} arrivals</span>
      </>
    );
    note = (
      <>
        Every train arriving in the selected city &mdash; from wherever
        it starts &mdash; for every train in the timetable window. &ldquo;Stops&rdquo; counts the stops the train
        makes before reaching {cur.en}.
      </>
    );
  } else {
    heading = (
      <>
        Departures from{" "}
        <span id="depCityName">
          {cur.en} &middot; {cur.o.zh}
        </span>{" "}
        &mdash; <span id="depCount">{cur.o.outbound} departures</span>
      </>
    );
    note = (
      <>
        Every train departing the selected city &mdash; from any of its
        stations &mdash; for every train in the timetable window. &ldquo;Stops&rdquo; counts the stops the train makes after leaving
        its origin-city station.
      </>
    );
  }
  return (
    <section id="departures">
      <h2>{heading}</h2>
      <p className="dep-note">{note}</p>
      <p className="dep-empty" role="status">
        Loading the train tables&hellip;
      </p>
    </section>
  );
}
