# Hand-adjudicated leg overrides (appended to leg_overrides.json)

## G2450 重庆东->成都东, 111 min, via [重庆西] (Chengyu + Chongqing West branch tiling, 374.4 km vs drawn 352.3 km)

Not assigned by the generic rule: the [重庆西] corridor family's floor is
100 min (err 11, inside tolerance), but the margin test compares against
the leave-one-out drawn prediction of 99 min — set by G2446, which is
itself misrouted on the same phantom geometry, so the margin is
meaningless for this pair.

Basis for adjudication:
- The (成都东, 重庆东) pair geometry (352.3 km, northern/Suining
  alignment) was flagged by the read-only atlas audit as a suspect
  direct-A* pair, never chainfill-corrected. G2450's 111 min over
  352.3 km implies ~190 km/h average over a corridor whose
  demonstrated services are D-class only.
- Online research (Chinese timetable/fan sources + live 12306 read)
  confirms G services to/from Chongqing East enter via the HSR
  (Chengyu/southern) side; no northern-route G service exists.
- G2450's 111 min exactly equals the fastest stopping service on the
  pair (G8608, 111 min via 重庆西), and the [重庆西] family's
  demonstrated floor range is 100-114 min — 111 sits inside it.
- Its pair-mate G2446 (99 min) IS assigned by the generic rule to the
  same [重庆西] family; the two trains are the same service pattern.
