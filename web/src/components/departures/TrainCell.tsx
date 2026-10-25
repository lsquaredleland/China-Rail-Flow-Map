/** The train cell shared by every table mode: class chip and number. */
export default function TrainCell({
  d,
  onClick,
}: {
  d: { code: string; cls: string };
  onClick?: () => void;
}) {
  const chip = d.cls === "plain" ? "普" : d.cls;
  const num = d.cls === "plain" ? d.code : d.code.replace(/^[A-Z]+/, "");
  const isHs = d.cls === "G" || d.cls === "D" || d.cls === "C";
  return (
    <button
      type="button"
      className={"train-cell" + (onClick ? " is-link" : "")}
      onClick={
        onClick
          ? (e) => {
              // Shift/cmd/ctrl clicks belong to the row's train selection;
              // a plain click opens the schedule without toggling the row.
              if (e.shiftKey || e.metaKey || e.ctrlKey) return;
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      title={onClick ? `View full schedule for train ${d.code}` : undefined}
    >
      <span className={"cls " + (isHs ? "cls-hs" : "cls-conv")}>{chip}</span>
      <b>{num || d.code}</b>
    </button>
  );
}
