import type { Direction, OriginVM } from "../types";

interface Props {
  cur: OriginVM | null;
  direction: Direction;
}

/* The explanatory notes are the page's closing footnote — the last
   content on the page, below the departures section. The dashed-leg
   note is outbound only: there is no inbound chord data, so in inbound
   mode it is hidden entirely. */
export default function Footnote(_props: Props) {
  return (
    <div id="legendNotes">
      <p className="note">
        Track geometry &copy; OpenStreetMap contributors (ODbL).
      </p>
    </div>
  );
}
