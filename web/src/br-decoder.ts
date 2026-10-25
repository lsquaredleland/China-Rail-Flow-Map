/* Fallback-only Brotli decoder, built as its own script by bundle.mjs and
   loaded on demand by fetchData (App.tsx). */
import { decompress } from "brotli/decompress.js";

(window as unknown as { __brDecode: typeof decompress }).__brDecode =
  decompress;
