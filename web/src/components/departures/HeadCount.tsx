/* The heading's big number, with a muted "of N" when a class filter narrows it. */
export function OfTotal({ n, total }: { n: number; total: number }) {
  return n !== total ? <span className="dep-of"> of {total}</span> : null;
}

export default function HeadCount({
  n,
  total,
  suffix = "",
  withOf = true,
}: {
  n: number | string;
  total: number;
  suffix?: string;
  /** false when the caller places <OfTotal> itself (the sentence headings). */
  withOf?: boolean;
}) {
  return (
    <>
      <b className="dep-num-lead">{n}</b>
      {suffix}
      {withOf && <OfTotal n={Number(n)} total={total} />}
    </>
  );
}
