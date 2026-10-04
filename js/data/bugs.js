/* Bug Hunt: each snippet has exactly one wrong line. The line marked "⟵BUG" in the source is the answer (the marker is stripped). */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;

  const b = (d, title, src, fix, why) => {
    const raw = U.trim(src).split("\n");
    const bug = raw.findIndex((l) => l.includes("⟵BUG"));
    const also = raw.map((l, i) => (l.includes("⟵ALSO") ? i : -1)).filter((i) => i >= 0);
    const lines = raw.map((l) => l.replace(/\s*⟵(BUG|ALSO)/, ""));
    return { d, title, lines, bug, also, fix, why };
  };

  const BANK = [
    /* ---------- Easy ---------- */
    b(1, "Sum every number in the list.", `
def total(nums):
    s = 1 ⟵BUG
    for x in nums:
        s += x
    return s`, "s = 0", "The running sum must start at 0, the identity for addition."),
    b(1, "Return the largest number in a non-empty list.", `
def largest(nums):
    best = 0 ⟵BUG
    for x in nums:
        if x > best:
            best = x
    return best`, "best = nums[0]", "Starting at 0 gives the wrong answer when every number is negative."),
    b(1, "Count the vowels in a word.", `
def vowels(word):
    count = 0
    for ch in word:
        if ch in "aeiou":
            count = 1 ⟵BUG
    return count`, "count += 1", "Assigning 1 resets the count instead of incrementing it."),
    b(1, "Return n! for n ≥ 0.", `
def factorial(n):
    if n == 0:
        return 0 ⟵BUG
    return n * factorial(n - 1)`, "return 1", "0! is 1. Returning 0 makes every product 0."),
    b(1, "Check whether s reads the same forwards and backwards.", `
def is_palindrome(s):
    i, j = 0, len(s) ⟵BUG
    while i < j:
        if s[i] != s[j]:
            return False
        i += 1
        j -= 1
    return True`, "i, j = 0, len(s) - 1", "len(s) is one past the last index, so s[j] raises IndexError."),
    b(1, "A stack: pop returns the most recently pushed item.", `
class Stack:
    def __init__(self):
        self.items = []
    def push(self, x):
        self.items.append(x)
    def pop(self):
        return self.items.pop(0) ⟵BUG`, "return self.items.pop()", "pop(0) removes the oldest item. That makes it a queue, not a stack."),
    b(1, "Return the n-th Fibonacci number (0, 1, 1, 2, 3, 5, …).", `
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + a ⟵BUG
    return a`, "a, b = b, a + b", "Each new term is the sum of the previous two."),
    b(1, "Return a reversed copy of the list.", `
def reverse(a):
    out = []
    for i in range(len(a), 0, -1): ⟵BUG
        out.append(a[i])
    return out`, "for i in range(len(a) - 1, -1, -1):", "The loop starts one past the end (IndexError) and never reaches index 0."),
    b(1, "Return True if any two numbers add up to target.", `
def has_pair(nums, target):
    seen = set()
    for x in nums:
        if x in seen: ⟵BUG
            return True
        seen.add(x)
    return False`, "if target - x in seen:", "We need the complement target − x, not x itself."),
    b(1, "Return the average of a non-empty list.", `
def average(nums):
    total = 0
    for x in nums:
        total += x
    return total / len(nums) - 1 ⟵BUG`, "return total / len(nums)", "Operator precedence: this subtracts 1 from the average."),

    /* ---------- Medium ---------- */
    b(2, "Binary search: return True if x is in the sorted list a.", `
def contains(a, x):
    lo, hi = 0, len(a) - 1
    while lo < hi: ⟵BUG
        mid = (lo + hi) // 2
        if a[mid] == x:
            return True
        if a[mid] < x:
            lo = mid + 1
        else:
            hi = mid - 1
    return False`, "while lo <= hi:", "With an inclusive hi, a one-element range (lo == hi) still needs checking. contains([5], 5) returns False."),
    b(2, "Bubble sort a list into ascending order.", `
def bubble_sort(a):
    n = len(a)
    for i in range(n):
        for j in range(n - i - 1):
            if a[j] < a[j + 1]: ⟵BUG
                a[j], a[j + 1] = a[j + 1], a[j]
    return a`, "if a[j] > a[j + 1]:", "Swapping when the left item is smaller sorts in descending order."),
    b(2, "Insertion sort a list into ascending order.", `
def insertion_sort(a):
    for i in range(1, len(a)):
        key = a[i]
        j = i - 1
        while j > 0 and a[j] > key: ⟵BUG
            a[j + 1] = a[j]
            j -= 1
        a[j + 1] = key
    return a`, "while j >= 0 and a[j] > key:", "With j > 0, nothing is ever compared against a[0], so the smallest value can be stranded at index 1."),
    b(2, "Reverse a singly linked list and return the new head.", `
def reverse(head):
    prev, cur = None, head
    while cur:
        nxt = cur.next
        cur.next = prev
        prev = nxt ⟵BUG
        cur = nxt
    return prev`, "prev = cur", "prev must become the node just re-pointed (cur). Setting it to nxt makes the next node point to itself."),
    b(2, "Merge two sorted lists into one sorted list.", `
def merge(a, b):
    i = j = 0
    out = []
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            out.append(a[i]); i += 1
        else:
            out.append(b[j]); j += 1
    return out + a[i:] ⟵BUG`, "return out + a[i:] + b[j:]", "Leftovers from b are dropped when a runs out first."),
    b(2, "Check that brackets are balanced.", `
def balanced(s):
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    for ch in s:
        if ch in "([{":
            stack.append(ch)
        elif not stack or stack.pop() != pairs[ch]:
            return False
    return True ⟵BUG`, "return not stack", "Unclosed openers like \"((\" leave items on the stack and should fail."),
    b(2, "Detect a cycle in a linked list (Floyd).", `
def has_cycle(head):
    slow = fast = head
    while fast and fast.next.next: ⟵BUG
        slow = slow.next
        fast = fast.next.next
        if slow is fast:
            return True
    return False`, "while fast and fast.next:", "When fast.next is None, fast.next.next raises AttributeError."),
    b(2, "Build prefix sums so that sum(a[i:j]) == p[j] - p[i].", `
def prefix_sums(a):
    p = [0] * len(a) ⟵BUG
    for i, x in enumerate(a):
        p[i + 1] = p[i] + x
    return p`, "p = [0] * (len(a) + 1)", "The prefix array needs n+1 slots. Writing p[n] raises IndexError."),
    b(2, "Maximum sum of any k consecutive elements (k ≤ len(a)).", `
def max_window(a, k):
    window = sum(a[:k])
    best = window
    for i in range(k, len(a)):
        window += a[i] - a[i - k + 1] ⟵BUG
        best = max(best, window)
    return best`, "window += a[i] - a[i - k]", "The element leaving the window is a[i − k]. The code subtracts the wrong one."),
    b(2, "Count islands of '1' cells in a grid.", `
def sink(grid, r, c):
    rows, cols = len(grid), len(grid[0])
    if r < 0 or c < 0 or r > rows or c > cols: ⟵BUG
        return
    if grid[r][c] != "1":
        return
    grid[r][c] = "0"
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        sink(grid, r + dr, c + dc)`, "if r < 0 or c < 0 or r >= rows or c >= cols:", "r == rows is already out of bounds, so grid[r] raises IndexError."),
    b(2, "Insert a value into a binary search tree.", `
def insert(node, val):
    if node is None:
        return Node(val)
    if val < node.val:
        node.left = insert(node.right, val) ⟵BUG
    else:
        node.right = insert(node.right, val)
    return node`, "node.left = insert(node.left, val)", "Smaller values must descend into the left subtree."),
    b(2, "Return True if word is stored in the trie.", `
def search(root, word):
    node = root
    for ch in word:
        if ch not in node.children:
            return False
        node = node.children[ch]
    return True ⟵BUG`, "return node.is_end", "Without the end-of-word flag, every prefix of a stored word counts as found."),
    b(2, "Merge sort a list.", `
def merge_sort(a):
    if len(a) <= 1:
        return a
    mid = len(a) // 2
    left = merge_sort(a[:mid])
    right = merge_sort(a[mid + 1:]) ⟵BUG
    return merge(left, right)`, "right = merge_sort(a[mid:])", "a[mid] belongs to neither half, so one element disappears."),
    b(2, "Memoised Fibonacci.", `
def fib(n, memo={}):
    if n < 2:
        return n
    if n in memo:
        return memo[n]
    return fib(n - 1) + fib(n - 2) ⟵BUG`, "memo[n] = fib(n - 1) + fib(n - 2); return memo[n]", "Nothing is ever stored in memo, so it is still exponential."),

    /* ---------- Hard ---------- */
    b(3, "Quicksort a[lo..hi] in place (Lomuto partition).", `
def partition(a, lo, hi):
    pivot = a[hi]
    i = lo
    for j in range(lo, hi):
        if a[j] < pivot:
            a[i], a[j] = a[j], a[i]
            i += 1
    a[i], a[hi] = a[hi], a[i]
    return i

def quicksort(a, lo, hi):
    if lo < hi:
        p = partition(a, lo, hi)
        quicksort(a, lo, p) ⟵BUG
        quicksort(a, p + 1, hi)`, "quicksort(a, lo, p - 1)", "The pivot is already in place. Including it means a range ending in its maximum recurses on itself forever."),
    b(3, "Dijkstra's shortest distances from source s.", `
def dijkstra(graph, s):
    dist = {s: 0}
    pq = [(0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w in graph[u]:
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                heapq.heappush(pq, (v, nd)) ⟵BUG
    return dist`, "heapq.heappush(pq, (nd, v))", "The heap orders tuples by their first field, so this pops by node name instead of distance."),
    b(3, "Union-Find: find the root of x with path compression.", `
def find(parent, x):
    if parent[x] != x:
        parent[x] = find(parent, parent[x])
    return x ⟵BUG`, "return parent[x]", "It returns x itself, so every element looks like its own root."),
    b(3, "Union-Find: merge the sets containing a and b.", `
def find(parent, x):
    while parent[x] != x:
        x = parent[x]
    return x

def union(parent, a, b):
    parent[a] = b ⟵BUG`, "parent[find(parent, a)] = find(parent, b)", "Re-pointing a non-root a detaches it from its own set instead of merging the two sets."),
    b(3, "Minimum coins to make amount (or -1 if impossible).", `
def min_coins(coins, amount):
    INF = float("inf")
    dp = [0] * (amount + 1) ⟵BUG
    for a in range(1, amount + 1):
        for c in coins:
            if c <= a:
                dp[a] = min(dp[a], dp[a - c] + 1)
    return dp[amount] if dp[amount] != INF else -1`, "dp = [0] + [INF] * amount", "Starting every cell at 0 makes min(…) always pick 0."),
    b(3, "Length of the longest strictly increasing subsequence.", `
def lis(a):
    dp = [1] * len(a)
    for i in range(len(a)):
        for j in range(i):
            if a[j] < a[i]:
                dp[i] = max(dp[i], dp[j]) ⟵BUG
    return max(dp, default=0)`, "dp[i] = max(dp[i], dp[j] + 1)", "Extending the subsequence ending at j adds one element."),
    b(3, "Maximum subarray sum (non-empty subarray).", `
def max_subarray(a):
    best = cur = 0 ⟵BUG
    for x in a:
        cur = max(x, cur + x)
        best = max(best, cur)
    return best`, "best = cur = a[0], then loop over a[1:]", "For an all-negative input it returns 0, which is the sum of an empty subarray."),
    b(3, "Kahn's topological sort of a DAG given as adjacency lists.", `
def topo(graph):
    indeg = {u: 0 for u in graph}
    for u in graph:
        for v in graph[u]:
            indeg[u] += 1 ⟵BUG
    queue = deque(u for u in graph if indeg[u] == 0)
    order = []
    while queue:
        u = queue.popleft()
        order.append(u)
        for v in graph[u]:
            indeg[v] -= 1
            if indeg[v] == 0:
                queue.append(v)
    return order`, "indeg[v] += 1", "An edge u → v adds to v's in-degree, not u's."),
    b(3, "Sift an item down a min-heap stored in a list.", `
def sift_down(h, i):
    n = len(h)
    while True:
        small, l, r = i, 2 * i + 1, 2 * i + 2
        if l < n and h[l] < h[small]:
            small = l
        if r < n and h[r] > h[small]: ⟵BUG
            small = r
        if small == i:
            return
        h[i], h[small] = h[small], h[i]
        i = small`, "if r < n and h[r] < h[small]:", "A min-heap must swap with the smaller child."),
    b(3, "Hash table insert with linear probing.", `
def insert(table, key):
    m = len(table)
    i = hash(key) % m
    while table[i] is not None:
        i = i + 1 ⟵BUG
    table[i] = key`, "i = (i + 1) % m", "Probing must wrap around the end of the table."),
    b(3, "Edit distance between strings a and b.", `
def edit(a, b):
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = 0 ⟵BUG
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            same = a[i - 1] == b[j - 1]
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                           dp[i - 1][j - 1] + (0 if same else 1))
    return dp[n][m]`, "dp[i][0] = i", "Turning the first i letters into an empty string takes i deletions."),
    b(3, "BFS order of a graph from start.", `
def bfs(graph, start):
    seen = set() ⟵BUG
    queue = deque([start])
    order = []
    while queue:
        u = queue.popleft()
        order.append(u)
        for v in graph[u]:
            if v not in seen:
                seen.add(v)
                queue.append(v)
    return order`, "seen = {start}", "The start is never marked, so a neighbour can enqueue it again and it appears twice."),
    b(3, "LRU cache get.", `
def get(self, key):
    if key not in self.data:   # self.data is an OrderedDict
        return -1
    return self.data[key] ⟵BUG`, "self.data.move_to_end(key); return self.data[key]", "A read must mark the key as most recently used, or eviction removes the wrong item."),

    /* ---------- Expert ---------- */
    b(4, "Lower bound: first index i with a[i] >= x.", `
def lower_bound(a, x):
    lo, hi = 0, len(a)
    while lo < hi:
        mid = (lo + hi) // 2
        if a[mid] < x:
            lo = mid + 1
        else:
            hi = mid - 1 ⟵BUG
    return lo`, "hi = mid", "In a half-open [lo, hi) search, mid itself may be the answer, so it can't be discarded."),
    b(4, "0/1 knapsack with a 1-D table.", `
def knapsack(items, cap):
    dp = [0] * (cap + 1)
    for weight, value in items:
        for w in range(weight, cap + 1): ⟵BUG
            dp[w] = max(dp[w], dp[w - weight] + value)
    return dp[cap]`, "for w in range(cap, weight - 1, -1):", "Iterating upward lets one item be reused, which solves the unbounded knapsack instead."),
    b(4, "Detect a cycle in a directed graph.", `
def has_cycle(graph):
    state = {}               # 1 = on the current path, 2 = done
    def dfs(u):
        state[u] = 1
        for v in graph[u]:
            if state.get(v) == 1:
                return True
            if v not in state and dfs(v):
                return True
        state[u] = 1 ⟵BUG
        return False
    return any(u not in state and dfs(u) for u in graph)`, "state[u] = 2", "A finished vertex must leave the current path. Otherwise a diamond-shaped DAG reports a cycle."),
    b(4, "Longest substring without repeating characters.", `
def longest(s):
    last = {}
    left = best = 0
    for right, ch in enumerate(s):
        if ch in last:
            left = last[ch] + 1 ⟵BUG
        last[ch] = right
        best = max(best, right - left + 1)
    return best`, "left = max(left, last[ch] + 1)", "An old occurrence to the left of the window would move left backwards. Try \"abba\"."),
    b(4, "Kruskal's minimum spanning tree weight.", `
def mst(n, edges):
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    total = 0
    for w, u, v in edges: ⟵BUG
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
            total += w
    return total`, "for w, u, v in sorted(edges):", "Kruskal must consider edges in increasing weight order."),
    b(4, "Count connected components with Union-Find.", `
def components(n, edges):
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            x = parent[x]
        return x
    count = n
    for u, v in edges:
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[u] = rv ⟵BUG
            count -= 1
    return count`, "parent[ru] = rv", "Re-pointing u instead of its root ru splits u off from its own set, so later edges can be counted as merges twice."),
    b(4, "Fenwick tree prefix sum of a[1..i].", `
def prefix(tree, i):
    s = 0
    while i > 0:
        s += tree[i]
        i += i & -i ⟵BUG
    return s`, "i -= i & -i", "Queries strip the lowest set bit going down. Adding it is the update direction."),
    b(4, "Number of distinct ways to make amount from coins (order doesn't matter).", `
def ways(coins, amount):
    dp = [1] + [0] * amount
    for a in range(1, amount + 1): ⟵BUG
        for c in coins: ⟵ALSO
            if c <= a:
                dp[a] += dp[a - c]
    return dp[amount]`, "Loop over coins in the outer loop and amounts in the inner loop", "With amounts outside, 1+2 and 2+1 are counted separately. That counts permutations, not combinations."),
    b(4, "Quickselect: k-th smallest (0-indexed).", `
def kth(a, k):
    pivot = random.choice(a)
    lo = [x for x in a if x < pivot]
    eq = [x for x in a if x == pivot]
    hi = [x for x in a if x > pivot]
    if k < len(lo):
        return kth(lo, k)
    if k < len(lo) + len(eq):
        return pivot
    return kth(hi, k - len(lo)) ⟵BUG`, "return kth(hi, k - len(lo) - len(eq))", "Everything in lo and in eq comes before hi, so both must be subtracted from k."),
    b(4, "Binary search on the answer: smallest speed to eat all piles within h hours.", `
def min_speed(piles, h):
    lo, hi = 1, max(piles)
    while lo < hi:
        mid = (lo + hi) // 2
        hours = sum((p + mid - 1) // mid for p in piles)
        if hours <= h:
            hi = mid
        else:
            lo = mid ⟵BUG
    return lo`, "lo = mid + 1", "When lo + 1 == hi and mid fails, lo = mid never moves, so the loop never ends."),
  ];

  function make(level, count) {
    return D.drawFromBank("bugs", BANK, level, count).map((x) => ({
      kind: "line",
      tag: "Debugging",
      prompt: `<p class="problem">${U.esc(x.title)}</p><p class="muted">Exactly one line is wrong. Click it.</p>`,
      lines: x.lines,
      answer: x.bug,
      accept: x.also,
      explain: `Fix: <code>${U.esc(x.fix)}</code>. ${U.esc(x.why)}`,
      key: x.key,
      bank: x.bank,
      review: U.esc(x.title),
    }));
  }

  D.registerMode({
    id: "bugs",
    name: "Bug Hunt",
    group: "Drills",
    topic: "Debugging",
    blurb: "Spot the single broken line in real algorithm code.",
    bankSize: BANK.length,
    count: 8,
    make,
  });
})();
