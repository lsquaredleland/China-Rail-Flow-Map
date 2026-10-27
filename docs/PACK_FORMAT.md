# Pack format: the per-train tables files

**Status:** current. Layout `crfm-tables-1` on pack `fmt` 6; the client has loaded the tables from these files since PR #140.

`atlas-v2-out-tables.safetensors` and `atlas-v2-in-tables.safetensors` are what
the client loads for the departures / arrivals tables and the train animation.
They hold exactly the content of `atlas-v2-out-tables.json` /
`atlas-v2-in-tables.json` (`atlaspack` and `audit` both assert this), stored as
integer columns so the browser can use them without parsing or building
objects.

- Writer: `pipeline/analyze/src/columns.rs` (`encode_tables`; `decode_tables`
  rebuilds the JSON).
- Reader: `web/src/lib/decode.ts` (`readSafetensors`, `expandOutColumns`,
  `expandInColumns`).
- What the values *mean* (signed section ids, throats, chord legs, stop
  positions): the header comment of `pipeline/analyze/src/bin/atlaspack.rs`.
  This page covers how they are stored.

## Container

A standard [safetensors](https://huggingface.co/docs/safetensors) file:

```
u64 little-endian N | N bytes of JSON header | tensors, back to back
```

The header maps each tensor name to `{dtype, shape, data_offsets: [begin, end]}`
(byte offsets counted from the end of the header), plus `__metadata__`:

```json
{"__metadata__": {"format": "crfm-tables-1", "pack": "out-tables", "fmt": "6", "doc": "docs/PACK_FORMAT.md"},
 "path_off": {"dtype": "U32", "shape": [11249], "data_offsets": [0, 44996]},
 "paths":    {"dtype": "I16", "shape": [854298], "data_offsets": [..., ...]},
 ...}
```

- `format` names this column layout; readers refuse any other value. Bump it
  when you add, remove or reinterpret a tensor. `fmt` is the pack format
  (`DATA_FMT`, the same as every JSON file).
- `dtype` is `I16`, `I32` or `U32`, little-endian. Value tensors use the
  narrowest of I16 / I32 that holds every value, so the type can change
  between packs; readers must go by `dtype`. Offset tensors are always U32.
- `shape` is `[n]`, or `[rows, width]` for a table of fixed-width rows
  (flattened row by row).
- Alignment: the header is padded with spaces to a multiple of 8, and all
  4-byte tensors come before the 2-byte ones, so every tensor starts at a
  multiple of its element size. The client relies on this to take typed
  views (`new Int16Array(buffer, offset, length)`) without copying.

Any safetensors reader opens the files. In Python, `safetensors.numpy.load_file`
(after `brotli -d`) returns one numpy array per tensor. `cargo test -p analyze-rs columns`
checks the committed files with the reference `safetensors` crate.

## Offsets: how lists are stored

Every list of lists is stored like Arrow's `List` type (also called CSR): one
flat `values` tensor plus an `off` tensor with one entry more than there are
lists. List `i` is `values[off[i] .. off[i+1]]`. For a `[rows, width]` tensor,
the offsets count rows, not values.

## Tensors

`<rows>` / `<mark>` / `<lists>` are `deps` / `dep_off` / `calls` in the out
file, and `arrs` / `arr_len` / `in_calls` in the in file.

| Tensor | Shape | Meaning |
|---|---|---|
| `path_off`, `paths` | `[T+1]`, `[P]` | `paths[t]`, train `t`'s full path (signed section / throat ids), as offsets + values. `T` = `train_table` length; empty for trains with no row. |
| `stop_off`, `stop_pos` | `[T+1]`, `[S]` | Out file only: `stop_pos[t]`, the path position of each stop. |
| `chord_train` | `[C]` | The trains that have chord legs (legs without track geometry). |
| `chord_off`, `chord_legs` | `[C+1]`, `[L, 3]` | Their legs, `[stop, s0, s1]` in full-path positions; train `chord_train[i]` owns rows `chord_off[i] .. chord_off[i+1]`. |
| `row_off` | `[O+1]` | Origin `o`'s rows are `row_off[o] .. row_off[o+1]`. `O` = 102 origins. |
| `<rows>` | `[R, 9]` | One dep / arr row per row index, the same 9 fields as the JSON (`RawDep` / `RawArr` in `web/src/types.ts`). |
| `<mark>` | `[R]` | Per row: `dep_off` (out, where the row's path starts inside its train's path) or `arr_len` (in, how long its prefix is). |
| `list_off` | `[O+1]` | Origin `o`'s call lists are `list_off[o] .. list_off[o+1]`, one per destination (out) / source (in) city. |
| `call_off`, `<lists>` | `[K+1]`, `[Q, 6 or 7]` | The call rows of each list, the same fields as the JSON (`RawCall` / `RawInCall`). |

## Worked example: rebuilding one departure row

For origin `o` and its `i`-th departure, in the out file:

```
r      = row_off[o] + i                      // global row index
row    = deps[r*9 .. r*9+9]                  // [train, from, dep, to, toCity, arr, dur, stops, km]
t      = row[0]
off    = dep_off[r]
path   = paths[path_off[t] + off .. path_off[t+1]]       // = JSON dep_secs[i]
sp     = stop_pos[stop_off[t] .. stop_off[t+1]]
stops  = sp[len(sp) - row[7] ..] each minus off           // = JSON dep_stop_pos[i]
legs   = chord legs of t with s0 >= off, positions minus off   // = JSON dep_chord_legs[i]
```

The in file is the same with `arrs`, and `path = paths[path_off[t] .. path_off[t] + arr_len[r]]`
(a prefix); its chord legs are those with `s1 <= arr_len[r]`, unshifted.
`expandOutColumns` / `expandInColumns` do exactly this, per origin, the first
time an origin's fields are read.

## Changing the layout

1. Change `encode_tables` / `decode_tables` in `columns.rs` and the reader in
   `decode.ts`; bump `FORMAT` in both.
2. Update this page.
3. Rebuild the pack (`docs/PIPELINE.md`); `atlaspack` refuses to write a file
   that does not decode back to its JSON, and `audit` re-checks the committed
   files in CI.
