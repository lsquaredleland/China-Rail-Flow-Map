import type { Direction, OriginVM } from "../types";

interface Props {
  cur: OriginVM | null;
  direction: Direction;
}

/* The explanatory notes are the page's closing footnote — the last
   content on the page, below the departures section. The dashed-leg
   note is outbound only: there is no inbound chord data, so in inbound
   mode it is hidden entirely. */
export default function Footnote({ cur, direction }: Props) {
  return (
    <div id="legendNotes">
      {direction === "out" ? (
        <p className="note" id="legendNote">
          {cur ? (
            <>
              <span className="dash"></span>
              Dashed = leg with no track routing, drawn straight (
              {cur.chords.length} for {cur.en}). All other lines follow the
              track.
            </>
          ) : null}
        </p>
      ) : null}
      <p className="note">
        Width &prop; distinct trains/day traversing each track section (each
        train counted once per section). City dots are sized by direct trains
        per day; a dot&rsquo;s colour is its fastest journey time. Click or
        tap a city for its crow-flies and rail distances.
      </p>
      <p className="note">
        Track geometry &copy; OpenStreetMap contributors (ODbL).
      </p>
    </div>
  );
}
