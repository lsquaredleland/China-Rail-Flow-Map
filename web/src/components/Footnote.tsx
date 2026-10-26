/* The page's closing footnote: the last content on the page, below the
   departures section. Today it carries the OpenStreetMap attribution only
   (the legend's explanatory notes moved into the legend card). */
export default function Footnote() {
  return (
    <div id="legendNotes">
      <p className="note">
        Track geometry &copy; OpenStreetMap contributors (ODbL).
      </p>
    </div>
  );
}
