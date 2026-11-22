// Deterministic allocator for octi (macOS, DYLD_INSERT_LIBRARIES).
// octi iterates std::set<Node*> / std::set<Edge*> ordered by pointer value, so its output
// depends on heap addresses, which ASLR randomises per run. This interposes malloc & co. with
// a size-class allocator over one fixed-address arena, so the same input gives the same
// addresses and therefore the same layout.
// build: clang -O2 -dynamiclib -o detmalloc.dylib detmalloc.c
// use:   DYLD_INSERT_LIBRARIES=$PWD/detmalloc.dylib [DETMALLOC_SEED=n] octi ... < in.json
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <malloc/malloc.h>
#include <stdlib.h>
#include <unistd.h>

#define ARENA_BASE ((uintptr_t)0x600000000000ULL)
#define ARENA_SIZE ((size_t)256 << 30)   /* 64 GiB virtual, reserved lazily */
#define HDR 16
#define NCLS 64

static char *arena = 0, *top = 0;
static char *tops[8];   // with a seed, fresh blocks go to one of 8 sub-arenas picked by a PRNG
static void *freel[NCLS];
static int inited = 0;
static uint64_t seed = 0;   // DETMALLOC_SEED: >0 inserts PRNG-sized gaps between fresh blocks,
                            // giving a different but reproducible pointer order ("seed")

static void init(void) {
  if (inited) return;
  void *p = mmap((void *)ARENA_BASE, ARENA_SIZE, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANON | MAP_FIXED | MAP_NORESERVE, -1, 0);
  if (p == MAP_FAILED) abort();
  arena = top = (char *)p;
  const char *e = getenv("DETMALLOC_SEED");
  if (e) { while (*e >= '0' && *e <= '9') seed = seed * 10 + (uint64_t)(*e++ - '0'); }
  for (int i = 0; i < 8; i++) tops[i] = arena + (ARENA_SIZE / 8) * i;
  inited = 1;
}

static int cls_of(size_t n) {  // classes: 16,32,48,...,256 then powers of two
  if (n <= 256) return (int)((n + 15) / 16);           // 0..16
  int c = 17; size_t s = 512;
  while (s < n) { s <<= 1; c++; }
  return c;
}
static size_t cls_size(int c) {
  if (c <= 16) return (size_t)(c ? c : 1) * 16;
  return (size_t)512 << (c - 17);
}

static int mine(const void *p) { return inited && (const char *)p >= arena && (const char *)p < arena + ARENA_SIZE; }

static void *dm_malloc(size_t n) {
  init();
  int c = cls_of(n ? n : 1);
  void *r;
  if (freel[c]) { r = freel[c]; freel[c] = *(void **)r; }
  else {
    size_t s = cls_size(c);
    char *b;
    if (seed) {
      seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
      int i = (int)(seed % 8); b = tops[i]; tops[i] += HDR + s;
      if (tops[i] > arena + (ARENA_SIZE / 8) * (i + 1)) abort();
    } else {
      b = top; top += HDR + s;
      if (top > arena + ARENA_SIZE) abort();
    }
    *(size_t *)b = (size_t)c;
    r = b + HDR;
  }
  return r;
}
static void dm_free(void *p) {
  if (!p) return;
  if (!mine(p)) { return; }  // foreign pointer (allocated before interposition): leak it
  int c = (int)*(size_t *)((char *)p - HDR);
  if (c == 255) return;
  *(void **)p = freel[c]; freel[c] = p;
}
static size_t dm_size(const void *p) {
  if (!mine(p)) return malloc_size(p);
  int c = (int)*(size_t *)((char *)p - HDR);
  if (c == 255) return *(size_t *)((char *)p - 8);
  return cls_size(c);
}
static void *dm_calloc(size_t a, size_t b) {
  size_t n = a * b; void *p = dm_malloc(n); memset(p, 0, n); return p;
}
static void *dm_realloc(void *p, size_t n) {
  if (!p) return dm_malloc(n);
  size_t o = dm_size(p);
  if (mine(p) && n <= o) return p;
  void *q = dm_malloc(n); memcpy(q, p, o < n ? o : n); dm_free(p); return q;
}
static int dm_posix_memalign(void **out, size_t al, size_t n) {
  // over-allocate and keep the header in front of the aligned pointer
  if (al <= 16) { *out = dm_malloc(n); return 0; }
  init();
  int c = cls_of(n + al);
  size_t s = cls_size(c);
  char *b;
  if (seed) { b = tops[0]; tops[0] += HDR + s; } else { b = top; top += HDR + s; }
  char *u = b + HDR;
  uintptr_t a = ((uintptr_t)u + al - 1) & ~(uintptr_t)(al - 1);
  *(size_t *)(a - HDR) = 255;          // aligned blocks are never recycled
  *(size_t *)(a - 8) = n;
  *out = (void *)a;
  return 0;
}
static void *dm_aligned_alloc(size_t al, size_t n) { void *p; dm_posix_memalign(&p, al, n); return p; }
static void *dm_valloc(size_t n) { return dm_aligned_alloc(4096, n); }

#define DYLD_INTERPOSE(_replacement, _replacee) \
  __attribute__((used)) static struct { const void *replacement; const void *replacee; } _interpose_##_replacee \
  __attribute__((section("__DATA,__interpose"))) = {(const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee};

DYLD_INTERPOSE(dm_malloc, malloc)
DYLD_INTERPOSE(dm_free, free)
DYLD_INTERPOSE(dm_calloc, calloc)
DYLD_INTERPOSE(dm_realloc, realloc)
DYLD_INTERPOSE(dm_size, malloc_size)
DYLD_INTERPOSE(dm_posix_memalign, posix_memalign)
DYLD_INTERPOSE(dm_aligned_alloc, aligned_alloc)
DYLD_INTERPOSE(dm_valloc, valloc)
