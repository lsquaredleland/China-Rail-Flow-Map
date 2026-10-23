import { useEffect, useRef, useState } from "react";
import type { RawOrigin } from "../types";
import { enName } from "../lib";

interface Props {
  origins: RawOrigin[];
  curIdx: number;
  onSelect: (idx: number) => void;
}

/* Searchable origin combobox: ranked list of the 100 origins, filterable
   by English or Chinese name, with full keyboard navigation. */
export default function CityPicker({ origins, curIdx, onSelect }: Props) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const comboRef = useRef<HTMLDivElement | null>(null);

  const cur = curIdx >= 0 ? origins[curIdx] : undefined;
  const display = (o: RawOrigin) => enName(o.en) + " · " + o.zh;

  // Origin indexes currently listed, given an input string.
  const computeItems = (v: string): number[] => {
    let q = v.trim().toLowerCase().replace(/\s+/g, "");
    // While the box still shows the selected city's name, list all.
    if (cur && v === display(cur)) q = "";
    const items: number[] = [];
    for (let i = 0; i < origins.length; i++) {
      const o = origins[i];
      const hay = (enName(o.en) + " " + o.en + " " + o.zh)
        .toLowerCase()
        .replace(/\s+/g, "");
      if (q && hay.indexOf(q) === -1) continue;
      items.push(i);
    }
    return items;
  };
  const items = computeItems(value);

  // Keep the box showing the selected city whenever the origin changes
  // from outside (initial load, a pick from this list).
  useEffect(() => {
    if (cur) setValue(display(cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curIdx, origins]);

  // Keep the active option scrolled into view, as the original did.
  useEffect(() => {
    if (!open || active < 0 || !listRef.current) return;
    const opts = listRef.current.querySelectorAll(".opt");
    if (opts[active]) opts[active].scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Clicking anywhere outside the combo restores the selected name.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!open) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest && t.closest(".combo")) return;
      if (cur) setValue(display(cur));
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, curIdx, origins]);

  const openList = () => {
    if (!origins.length) return;
    setActive(
      items.length ? Math.max(0, items.indexOf(curIdx)) : -1,
    );
    setOpen(true);
  };

  const choose = (pos: number) => {
    if (pos < 0 || pos >= items.length) return;
    onSelect(items[pos]);
    setOpen(false);
    if (inputRef.current) inputRef.current.blur();
  };

  return (
    <div className="combo" ref={comboRef}>
      <input
        id="originSearch"
        type="text"
        role="combobox"
        aria-expanded={open ? "true" : "false"}
        aria-controls="originList"
        aria-autocomplete="list"
        aria-activedescendant=""
        autoComplete="off"
        spellCheck={false}
        placeholder="Search 100 cities…"
        aria-label="Search and choose the origin city"
        ref={inputRef}
        value={value}
        onFocus={(e) => {
          e.target.select();
          openList();
        }}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (!open) setOpen(true);
          const next = computeItems(v);
          setActive(next.length ? 0 : -1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              openList();
              return;
            }
            if (!items.length) return;
            setActive(
              e.key === "ArrowDown"
                ? Math.min(items.length - 1, active + 1)
                : Math.max(0, active - 1),
            );
          } else if (e.key === "Enter") {
            if (open && active >= 0) {
              e.preventDefault();
              choose(active);
            }
          } else if (e.key === "Escape") {
            if (cur) setValue(display(cur));
            setOpen(false);
            if (inputRef.current) inputRef.current.blur();
          }
        }}
      />
      <div
        id="originList"
        role="listbox"
        aria-label="Origin cities"
        hidden={!open}
        ref={listRef}
        onMouseDown={(e) => {
          const t = e.target as HTMLElement | null;
          const opt = t && t.closest ? t.closest(".opt") : null;
          if (!opt) return;
          e.preventDefault(); // keep focus until we've chosen
          choose(parseInt(opt.getAttribute("data-pos") || "0", 10));
        }}
      >
        {items.length === 0 ? (
          <div className="none">No city matches that search.</div>
        ) : (
          items.map((originIdx, pos) => {
            const o = origins[originIdx];
            return (
              <div
                key={originIdx}
                className={"opt" + (pos === active ? " active" : "")}
                role="option"
                data-pos={pos}
                aria-selected={originIdx === curIdx ? "true" : "false"}
              >
                <span className="rk">#{originIdx + 1}</span>{" "}
                {enName(o.en)} {o.zh}{" "}
                <span className="cnt">
                  &mdash; {o.outbound.toLocaleString("en-US")} trains/day
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
