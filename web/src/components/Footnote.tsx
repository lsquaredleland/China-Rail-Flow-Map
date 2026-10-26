/* The page's closing footnote: the last content on the page, below the
   departures section. It carries the OpenStreetMap attribution and, in
   national mode, a one-line key to the circles and flows. */
export default function Footnote({ national = false }: { national?: boolean }) {
  return (
    <div id="legendNotes">
      {national && (
        <p className="note">
          National view: line width is the trains per day on a track section, circle size is a
          city's departures plus arrivals per day, and both grow as the 24-hour clock runs.
        </p>
      )}
      <p className="note">
        Track geometry &copy; OpenStreetMap contributors (ODbL).
      </p>
    </div>
  );
}
