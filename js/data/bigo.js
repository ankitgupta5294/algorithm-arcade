/* Big-O Blitz: hand-written complexity questions, tagged by difficulty (d: 1 Easy … 4 Expert). */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;

  const POOL = ["O(1)", "O(log n)", "O(√n)", "O(n)", "O(n log n)", "O(n²)", "O(n³)", "O(2ⁿ)", "O(n!)"];
  const q = (d, a, code, why, opts) => ({ d, a, code: U.trim(code), why, opts });

  const BANK = [
    /* ---------- Easy ---------- */
    q(1, "O(n)", `
total = 0
for x in nums:
    total += x`, "One pass over n items with constant work each."),
    q(1, "O(1)", `
x = nums[k]          # nums is a Python list`, "Arrays support direct indexing: the address of slot k is computed, not searched for."),
    q(1, "O(n²)", `
for i in range(n):
    for j in range(n):
        total += grid[i][j]`, "Two nested loops of n steps each: n × n."),
    q(1, "O(1)", `
seen = {}            # dict (hash map)
seen[key] = True
if key in seen:
    print("hit")`, "Hash map insert and lookup are O(1) on average."),
    q(1, "O(log n)", `
i = 1
while i < n:
    i *= 2`, "i doubles every pass, so it reaches n after about log₂ n passes."),
    q(1, "O(n)", `
for i in range(n):
    for j in range(100):
        work(i, j)`, "The inner loop is a fixed 100 steps regardless of n, so it only adds a constant factor."),
    q(1, "O(n)", `
node = head
while node and node.val != target:
    node = node.next`, "A linked list has no index, so finding a value may walk every node."),
    q(1, "O(n)", `
for x in a:
    print(x)
for x in a:
    print(x * 2)`, "Two loops one after another cost n + n = 2n. Constants drop, so O(n)."),
    q(1, "O(1)", `
stack.append(x)      # push onto a Python list`, "Appending to the end of a dynamic array is amortised O(1)."),
    q(1, "O(n)", `
biggest = max(nums)`, "max() has to look at every element once."),
    q(1, "O(n)", `
if target in nums:   # nums is a list
    print("found")`, "Membership on a list is a linear scan."),
    q(1, "O(1)", `
if target in seen:   # seen is a set
    print("found")`, "Sets are hash tables, so membership is O(1) on average."),
    q(1, "O(1)", `
top = stack.pop()    # pop from the end of a list`, "Removing the last element needs no shifting."),
    q(1, "O(n)", `
for i in range(0, n, 2):
    work(i)`, "n/2 iterations is still proportional to n."),
    q(1, "O(1)", `
for i in range(10):
    print(nums[i])`, "Ten iterations no matter how large n gets."),
    q(1, "O(n²)", `
for i in range(n):
    for j in range(n):
        if i != j and a[i] == a[j]:
            return True`, "It compares every pair of positions: n × n checks in the worst case."),
    q(1, "O(log n)", `
while n > 1:
    n = n // 2`, "Halving n each step takes log₂ n steps to reach 1."),
    q(1, "O(n)", `
s = s[::-1]          # reverse a string of length n`, "Slicing builds a new string and copies all n characters."),

    /* ---------- Medium ---------- */
    q(2, "O(n²)", `
for i in range(n):
    for j in range(i):
        if a[j] > a[i]:
            count += 1`, "The inner loop runs 0 + 1 + … + (n−1) = n(n−1)/2 times. Half of n² is still O(n²)."),
    q(2, "O(log n)", `
lo, hi = 0, len(a) - 1
while lo <= hi:
    mid = (lo + hi) // 2
    if a[mid] == x: return mid
    if a[mid] < x: lo = mid + 1
    else: hi = mid - 1`, "Binary search halves the remaining range every iteration."),
    q(2, "O(n log n)", `
def merge_sort(a):
    if len(a) <= 1:
        return a
    m = len(a) // 2
    return merge(merge_sort(a[:m]),
                 merge_sort(a[m:]))`, "There are log n levels of splitting and the merges on each level do O(n) work in total."),
    q(2, "O(log n)", `
import heapq
heapq.heappush(heap, x)    # heap holds n items`, "The new item sifts up a binary heap, which is about log₂ n levels tall."),
    q(2, "O(n)", `
a.insert(0, x)       # a is a Python list`, "Inserting at the front shifts every existing element one slot to the right."),
    q(2, "O(n)", `
i, j = 0, len(a) - 1      # a is sorted
while i < j:
    s = a[i] + a[j]
    if s == target: return True
    if s < target: i += 1
    else: j -= 1`, "Two pointers move toward each other and every step moves one of them, so at most n steps."),
    q(2, "O(n)", `
def total(node):
    if node is None:
        return 0
    return node.val + total(node.left) + total(node.right)`, "Every node of the tree is visited exactly once."),
    q(2, "O(n log n)", `
a.sort()             # Python's Timsort`, "Comparison sorts need Ω(n log n) comparisons in the worst case, and Timsort achieves O(n log n)."),
    q(2, "O(n²)", `
out = []
for x in a:
    out = out + [x]      # builds a brand-new list`, "out + [x] copies the whole list every time: 1 + 2 + … + n copies. out.append(x) would make it O(n)."),
    q(2, "O(n log n)", `
for i in range(n):
    j = 1
    while j < n:
        j *= 2`, "An O(log n) doubling loop, run n times."),
    q(2, "O(√n)", `
i = 1
while i * i <= n:
    i += 1`, "The loop stops once i passes √n."),
    q(2, "O(√n)", `
def is_prime(n):
    d = 2
    while d * d <= n:
        if n % d == 0:
            return False
        d += 1
    return n >= 2`, "Trial division only needs to test divisors up to √n."),
    q(2, "O(V + E)", `
queue = deque([start]); seen = {start}
while queue:
    v = queue.popleft()
    for w in graph[v]:
        if w not in seen:
            seen.add(w); queue.append(w)`, "Breadth-first search enqueues each vertex once and scans each adjacency list once.",
      ["O(V + E)", "O(V · E)", "O(V²)", "O(E log V)"]),
    q(2, "O(n³)", `
for i in range(n):
    for j in range(n):
        for k in range(n):
            C[i][j] += A[i][k] * B[k][j]`, "Naive matrix multiplication: three nested loops of n."),
    q(2, "O(n²)", `
def total(a):
    if not a:
        return 0
    return a[0] + total(a[1:])`, "a[1:] copies the rest of the list on every call: (n−1) + (n−2) + … ≈ n²/2. Pass an index instead for O(n)."),
    q(2, "O(n²)", `
while queue:              # queue is a list of n items
    item = queue.pop(0)
    handle(item)`, "list.pop(0) shifts every remaining element, so each pop is O(n). Use collections.deque."),
    q(2, "O(n)", `
queue = deque(items)      # n items
while queue:
    item = queue.popleft()
    handle(item)`, "deque.popleft() is O(1), so n pops cost O(n)."),
    q(2, "O(n)", `
left = 0
for right in range(n):
    window += a[right]
    while window > limit:
        window -= a[left]
        left += 1`, "left only ever moves forward, so the inner loop runs at most n times in total."),
    q(2, "O(n · m)", `
for x in A:          # len(A) == n
    for y in B:      # len(B) == m
        if x == y:
            matches += 1`, "The loops run over different inputs, so the cost is n × m.",
      ["O(n · m)", "O(n + m)", "O(n²)", "O(m log n)"]),
    q(2, "O(n)", `
from collections import Counter
counts = Counter(words)   # n words`, "Counter does one hash-map update per word."),
    q(2, "O(n log n)", `
for x in nums:            # n numbers
    heapq.heappush(h, x)`, "n pushes, each O(log n). heapq.heapify(nums) would do it in O(n)."),
    q(2, "O(log n)", `
import bisect
i = bisect.bisect_left(sorted_nums, x)`, "bisect is binary search over the sorted list."),

    /* ---------- Hard ---------- */
    q(3, "O(2ⁿ)", `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)`, "Each call branches into two and nothing is cached, so the call tree grows exponentially (about 1.618ⁿ, which is O(2ⁿ))."),
    q(3, "O(n)", `
import heapq
heapq.heapify(a)          # a has n items`, "Floyd's bottom-up heapify: most nodes sit near the leaves and sift only a short way. The total work sums to under 2n."),
    q(3, "O(n log n)", `
for i in range(1, n):
    j = i
    while j > 0:
        j //= 2`, "The inner loop runs about log₂ i times. Summed over i that is log(n!) = Θ(n log n)."),
    q(3, "O(n log n)", `
for i in range(1, n + 1):
    for j in range(i, n + 1, i):
        work(j)`, "The inner loop runs n/i times: n/1 + n/2 + … + n/n = n · Hₙ ≈ n ln n."),
    q(3, "O(n)", `
from functools import lru_cache
@lru_cache(None)
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)`, "With memoisation each fib(k) is computed once, for k = 0…n."),
    q(3, "O(n · n!)", `
def perms(a):
    if len(a) <= 1:
        return [a]
    out = []
    for i in range(len(a)):
        for p in perms(a[:i] + a[i+1:]):
            out.append([a[i]] + p)
    return out`, "There are n! permutations and building each one copies up to n elements.",
      ["O(n · n!)", "O(2ⁿ)", "O(n²)", "O(n³)"]),
    q(3, "O(n · 2ⁿ)", `
def subsets(a):
    if not a:
        return [[]]
    rest = subsets(a[1:])
    return rest + [[a[0]] + s for s in rest]`, "There are 2ⁿ subsets and copying each takes up to n.",
      ["O(n · 2ⁿ)", "O(n!)", "O(n²)", "O(n log n)"]),
    q(3, "O(n)", `
def count(lo, hi):
    if hi - lo <= 1:
        return hi - lo
    mid = (lo + hi) // 2
    return count(lo, mid) + count(mid, hi)`, "T(n) = 2T(n/2) + O(1). The recursion tree has about 2n nodes, each doing constant work."),
    q(3, "O(n)", `
def f(a):
    if len(a) <= 1:
        return
    total = sum(a)
    f(a[:len(a) // 2])`, "T(n) = T(n/2) + O(n): n + n/2 + n/4 + … ≤ 2n."),
    q(3, "O((V + E) log V)", `
dist = {s: 0}; pq = [(0, s)]
while pq:
    d, u = heapq.heappop(pq)
    if d > dist[u]:
        continue
    for v, w in graph[u]:
        if d + w < dist.get(v, inf):
            dist[v] = d + w
            heapq.heappush(pq, (d + w, v))`, "Dijkstra with a binary heap: every edge can cause one O(log V) push, and every vertex is popped.",
      ["O((V + E) log V)", "O(V + E)", "O(V² · E)", "O(E · V log V)"]),
    q(3, "O(n²)", `
def quicksort(a):         # called on already-sorted input
    if len(a) <= 1:
        return a
    p = a[0]
    smaller = [x for x in a[1:] if x < p]
    larger = [x for x in a[1:] if x >= p]
    return quicksort(smaller) + [p] + quicksort(larger)`, "With the first element as pivot, sorted input puts everything in larger, so each level removes only one element: n + (n−1) + … = O(n²)."),
    q(3, "O(√n)", `
i, step = 0, 0
while i < n:
    step += 1
    i += step`, "After k steps i = k(k+1)/2, which passes n when k ≈ √(2n)."),
    q(3, "O(n)", `
j = 0
for i in range(n):
    while j < n and a[j] <= a[i]:
        j += 1`, "j never moves backwards, so the inner loop runs at most n times across the whole outer loop."),
    q(3, "O(n)", `
if key in s:     # every key in s has the same hash`, "When all keys collide they share one bucket, and lookup degrades to a linear scan."),
    q(3, "O(2ⁿ)", `
def f(n):
    if n == 0:
        return
    f(n - 1)
    f(n - 1)`, "T(n) = 2T(n−1) + O(1). The call tree is a full binary tree of depth n."),
    q(3, "O(log² n)", `
i = 1
while i < n:
    j = 1
    while j < n:
        j *= 2
    i *= 2`, "log n outer iterations, each running a log n inner loop.",
      ["O(log² n)", "O(log n)", "O(n)", "O(n log n)"]),
    q(3, "O(n)", `
stack = []
for x in nums:            # n numbers
    while stack and stack[-1] < x:
        stack.pop()
    stack.append(x)`, "Each element is pushed once and popped at most once, so the whole monotonic stack pass is O(n)."),
    q(3, "O(log n)", `
node = root          # root of an AVL tree with n nodes
while node and node.key != k:
    node = node.left if k < node.key else node.right`, "An AVL tree stays balanced, so its height is O(log n)."),
    q(3, "O(n)", `
node = root          # BST built by inserting 1, 2, …, n in order
while node and node.key != k:
    node = node.left if k < node.key else node.right`, "Inserting sorted keys into a plain BST makes a linked list of height n."),
    q(3, "O(n log n)", `
heapq.heapify(a)
out = [heapq.heappop(a) for _ in range(len(a))]`, "Heapify is O(n), then n pops at O(log n) each. This is heap sort."),

    /* ---------- Expert ---------- */
    q(4, "O(n^log₂3)", `
def f(n):
    if n <= 1:
        return 1
    work(n)                       # O(n)
    return f(n // 2) + f(n // 2) + f(n // 2)`, "T(n) = 3T(n/2) + O(n). By the master theorem n^log₂3 ≈ n^1.585 dominates n. This is Karatsuba's recurrence.",
      ["O(n^log₂3)", "O(n log n)", "O(n²)", "O(n log² n)"]),
    q(4, "O(n log² n)", `
def f(a):
    if len(a) <= 1:
        return a
    a.sort()                      # O(n log n)
    m = len(a) // 2
    return f(a[:m]) + f(a[m:])`, "T(n) = 2T(n/2) + O(n log n). Each of the log n levels costs O(n log n).",
      ["O(n log² n)", "O(n log n)", "O(n²)", "O(n² log n)"]),
    q(4, "O(n²)", `
def f(n):
    if n <= 1:
        return 1
    work(n)                       # O(n)
    return sum(f(n // 2) for _ in range(4))`, "T(n) = 4T(n/2) + O(n). n^log₂4 = n² dominates the O(n) work."),
    q(4, "O(n²)", `
def f(a):
    if not a:
        return 0
    m = max(a)                    # O(n)
    a.remove(m)                   # O(n)
    return m + f(a)`, "T(n) = T(n−1) + O(n) = n + (n−1) + … = O(n²)."),
    q(4, "O(log log n)", `
i = 2
while i < n:
    i = i * i`, "i goes 2, 4, 16, 256, …: i = 2^(2^k). That passes n after k = log log n steps.",
      ["O(log log n)", "O(log n)", "O(√n)", "O(1)"]),
    q(4, "O(n log log n)", `
is_prime = [True] * (n + 1)
for p in range(2, n + 1):
    if is_prime[p]:
        for m in range(p * p, n + 1, p):
            is_prime[m] = False`, "The sieve of Eratosthenes does n/p work per prime p, and the sum of 1/p over primes up to n is about ln ln n.",
      ["O(n log log n)", "O(n log n)", "O(n√n)", "O(n²)"]),
    q(4, "O(V³)", `
for k in range(V):
    for i in range(V):
        for j in range(V):
            d[i][j] = min(d[i][j], d[i][k] + d[k][j])`, "Floyd–Warshall: three nested loops over the vertices.",
      ["O(V³)", "O(V² log V)", "O(V · E)", "O(V²)"]),
    q(4, "O(n + m)", `
lps = build_prefix_table(pattern)   # m chars, O(m)
j = 0
for ch in text:                     # n chars
    while j and ch != pattern[j]:
        j = lps[j - 1]
    if ch == pattern[j]:
        j += 1
    if j == len(pattern):
        found(); j = lps[j - 1]`, "KMP: j rises at most n times overall, so the fallbacks are bounded by n too. The prefix table costs O(m).",
      ["O(n + m)", "O(n · m)", "O(n log m)", "O(n²)"]),
    q(4, "O(V · E)", `
for _ in range(V - 1):
    for u, v, w in edges:
        if dist[u] + w < dist[v]:
            dist[v] = dist[u] + w`, "Bellman–Ford relaxes all E edges V−1 times.",
      ["O(V · E)", "O(V + E)", "O((V + E) log V)", "O(E²)"]),
    q(4, "O(log n)", `
def query(node, lo, hi, l, r):      # segment tree over n items
    if r < lo or hi < l:
        return 0
    if l <= lo and hi <= r:
        return tree[node]
    mid = (lo + hi) // 2
    return (query(2*node, lo, mid, l, r) +
            query(2*node+1, mid+1, hi, l, r))`, "At most four nodes per level are visited and the tree has O(log n) levels."),
    q(4, "O(n)", `
def build(node, lo, hi):            # n = hi - lo + 1 items
    if lo == hi:
        tree[node] = a[lo]; return
    mid = (lo + hi) // 2
    build(2*node, lo, mid)
    build(2*node+1, mid+1, hi)
    tree[node] = tree[2*node] + tree[2*node+1]`, "T(n) = 2T(n/2) + O(1): the segment tree has about 2n nodes, each built once."),
    q(4, "O(log min(a, b))", `
def gcd(a, b):
    while b:
        a, b = b, a % b
    return a`, "Euclid's algorithm: every two steps the smaller number at least halves.",
      ["O(log min(a, b))", "O(min(a, b))", "O(√a)", "O(a · b)"]),
    q(4, "O(log n)", `
def power(x, n):
    result = 1
    while n:
        if n & 1:
            result *= x
        x *= x
        n >>= 1
    return result`, "Fast exponentiation handles one bit of n per iteration (counting multiplications as O(1))."),
    q(4, "O(n + k)", `
count = [0] * (k + 1)      # values are in 0..k
for x in a:                # n values
    count[x] += 1
out = []
for v in range(k + 1):
    out.extend([v] * count[v])`, "Counting sort: one pass over the n values and one pass over the k+1 buckets.",
      ["O(n + k)", "O(n log n)", "O(n · k)", "O(k log n)"]),
    q(4, "O(L)", `
node = root                # trie already holds n words
for ch in word:            # word has L characters
    node = node.children.setdefault(ch, Node())
node.end = True`, "Trie insertion walks one node per character and doesn't depend on how many words are stored.",
      ["O(L)", "O(n · L)", "O(log n)", "O(n)"]),
    q(4, "O(n!)", `
def place(row, cols):      # safe() is O(1) using sets
    if row == n:
        solutions.append(cols)
        return
    for c in range(n):
        if safe(row, c, cols):
            place(row + 1, cols + [c])`, "N-Queens backtracking: row r has at most n−r safe columns, bounding the search by n!.",
      ["O(n!)", "O(2ⁿ)", "O(n³)", "O(n²)"]),
    q(4, "O(n · m)", `
for i in range(1, n + 1):
    for j in range(1, m + 1):
        if a[i-1] == b[j-1]:
            dp[i][j] = dp[i-1][j-1] + 1
        else:
            dp[i][j] = max(dp[i-1][j], dp[i][j-1])`, "Longest common subsequence fills an (n+1) × (m+1) table with O(1) work per cell.",
      ["O(n · m)", "O(n + m)", "O(2ⁿ⁺ᵐ)", "O(n² · m)"]),
    q(4, "O(n² · 2ⁿ)", `
for mask in range(1 << n):
    for last in range(n):
        if dp[mask][last] == inf: continue
        for nxt in range(n):
            if not mask & (1 << nxt):
                new = mask | (1 << nxt)
                dp[new][nxt] = min(dp[new][nxt],
                                   dp[mask][last] + cost[last][nxt])`, "Held–Karp travelling salesman: 2ⁿ masks × n last cities × n next cities.",
      ["O(n² · 2ⁿ)", "O(n!)", "O(2ⁿ)", "O(n³)"]),
    q(4, "O(m · α(n))", `
def find(x):
    if parent[x] != x:
        parent[x] = find(parent[x])    # path compression
    return parent[x]
# m calls to union(a, b), each using union by rank`, "With path compression and union by rank each operation costs amortised α(n), the inverse Ackermann function, which is at most 4 in practice.",
      ["O(m · α(n))", "O(m · n)", "O(m²)", "O(n²)"]),
    q(4, "O(n)", `
def quickselect(a, k):        # average case, random pivot
    p = random.choice(a)
    lo = [x for x in a if x < p]
    hi = [x for x in a if x > p]
    if k < len(lo):
        return quickselect(lo, k)
    if k >= len(a) - len(hi):
        return quickselect(hi, k - (len(a) - len(hi)))
    return p`, "Average case: the list shrinks by a constant factor in expectation, so the work is a geometric series in n. The worst case is O(n²)."),
    q(4, "O(log n)", `
def update(i, delta):         # Fenwick tree over n items
    while i <= n:
        tree[i] += delta
        i += i & -i`, "Adding the lowest set bit moves i to its next responsible ancestor. That happens at most log₂ n times."),
  ];

  function make(level, count) {
    return D.drawFromBank("bigo", BANK, level, count).map((b) => {
      let opts;
      if (b.opts) opts = U.shuffle(b.opts.slice());
      else {
        const idx = POOL.indexOf(b.a);
        const near = POOL.filter((p, i) => p !== b.a && Math.abs(i - idx) <= 3);
        opts = U.shuffle([b.a, ...U.sample(near, 3)]);
      }
      return {
        kind: "choice",
        tag: "Complexity",
        prompt: "What is the time complexity of this code?" + (b.d >= 3 ? " <span class=\"muted\">(worst case unless stated)</span>" : ""),
        code: b.code,
        options: opts,
        answer: b.a,
        explain: U.esc(b.why),
        key: b.key,
        bank: b.bank,
        review: "Complexity of:",
      };
    });
  }

  D.registerMode({
    id: "bigo",
    name: "Big-O Blitz",
    group: "Drills",
    topic: "Complexity",
    blurb: "Read a snippet, call its time complexity before the clock runs out.",
    bankSize: BANK.length,
    count: 10,
    timer: (lvl) => [25, 20, 20, 25][lvl - 1],
    make,
  });
})();
