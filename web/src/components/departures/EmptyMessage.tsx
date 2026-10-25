import type { DecodedAtlas, Direction, OriginVM } from "../../types";
import { enName, trainOrigins } from "../../lib";

export interface EmptyProps {
  atlas?: DecodedAtlas | null;
  cur: OriginVM | null;
  direction: Direction;
  /** The raw search box text. */
  query: string;
  /** The active direction's per-train tables have landed. */
  tablesLoaded: boolean;
  onSelectOrigin?: (idx: number) => void;
}

/* Empty-state text. A train-code search with no rows here points at the
   origins that train does serve; picking one keeps the query. */
export default function EmptyMessage({
  atlas,
  cur,
  direction,
  query,
  tablesLoaded,
  onSelectOrigin,
}: EmptyProps) {
  const plain = "No trains match that filter.";
  const code = query.trim().toLowerCase();
  if (!atlas || !cur || !tablesLoaded || !/^[gdcsztk]?\d{1,5}$/.test(code)) {
    return <>{plain}</>;
  }
  const idx = trainOrigins(atlas, direction);
  const origins = atlas.data.origins;
  const here = enName(cur.o.en) + " · " + cur.o.zh;
  const cities = (list: number[]) =>
    list.map((oi, i) => (
      <span key={oi}>
        {i > 0 ? " · " : ""}
        <button
          type="button"
          className="linklike"
          onClick={() => onSelectOrigin?.(oi)}
        >
          {enName(origins[oi].en)} &middot; {origins[oi].zh}
        </button>
      </span>
    ));
  const exact = idx.get(code);
  if (exact) {
    const label = code.toUpperCase();
    return (
      <>
        {label} doesn&rsquo;t {direction === "out" ? "depart from" : "arrive in"}{" "}
        {here} &mdash; it {direction === "out" ? "departs from" : "arrives in"}:{" "}
        {cities(exact)}
      </>
    );
  }
  const near = [...idx.keys()].filter((c) => c.startsWith(code)).sort().slice(0, 8);
  if (near.length === 0) return <>{plain}</>;
  return (
    <>
      {plain} Similar codes:
      {near.map((c) => (
        <div key={c}>
          {c.toUpperCase()}: {cities(idx.get(c)!.slice(0, 8))}
        </div>
      ))}
    </>
  );
}
