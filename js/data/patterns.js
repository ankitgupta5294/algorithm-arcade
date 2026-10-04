/* Pattern Spotter: match an interview-style problem to the technique that cracks it. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;

  const T = {
    hash: "Hash map",
    two: "Two pointers",
    slide: "Sliding window",
    bs: "Binary search",
    bsa: "Binary search on the answer",
    stack: "Stack",
    mstack: "Monotonic stack",
    mdeque: "Monotonic deque",
    heap: "Heap / priority queue",
    bfs: "BFS",
    dfs: "DFS",
    back: "Backtracking",
    dp: "Dynamic programming",
    greedy: "Greedy",
    uf: "Union-Find",
    topo: "Topological sort",
    trie: "Trie",
    prefix: "Prefix sums",
    dijk: "Dijkstra",
    bf: "Bellman-Ford",
    intervals: "Sort + sweep intervals",
    fast: "Fast & slow pointers",
    bits: "Bit manipulation",
    seg: "Segment / Fenwick tree",
    dc: "Divide and conquer",
    qsel: "Quickselect",
  };
  const ALL = Object.values(T);

  // p(level, answer, problem, why, alsoValid[])
  const p = (d, a, text, why, alt = []) => ({ d, a, text, why, alt });

  const BANK = [
    /* ---------- Easy ---------- */
    p(1, T.hash, "Given an unsorted array and a target, return the indices of the two numbers that add up to the target, in one pass.", "Store each value's index in a hash map and look up target − x as you go: O(n).", [T.two]),
    p(1, T.stack, "Decide whether a string of brackets like \"([]{})\" is balanced.", "Push openers. Each closer must match the opener on top of the stack.", []),
    p(1, T.fast, "Detect whether a singly linked list has a cycle using O(1) extra memory.", "Floyd's tortoise and hare: if there is a cycle, the fast pointer eventually laps the slow one.", []),
    p(1, T.hash, "Find the first character in a string that never repeats.", "Count characters in a hash map, then scan again for the first count of 1.", []),
    p(1, T.bs, "Check whether a value exists in a sorted array of a million numbers, as fast as possible.", "Sorted input + lookup = binary search in O(log n).", []),
    p(1, T.two, "Check whether a string is a palindrome, ignoring punctuation and case.", "One pointer from each end, skipping non-alphanumerics, moving inward.", []),
    p(1, T.slide, "Find the maximum sum of any k consecutive elements.", "Slide a fixed-size window: add the new element, subtract the one that leaves.", [T.prefix]),
    p(1, T.prefix, "Answer thousands of \"sum of a[i..j]\" queries on an array that never changes.", "Precompute prefix[i] = a[0] + … + a[i−1]; each query is prefix[j+1] − prefix[i].", [T.seg]),
    p(1, T.two, "Merge two sorted arrays into one sorted array.", "Walk both arrays with one pointer each and take the smaller head every step.", [T.heap]),
    p(1, T.bits, "Every number in an array appears twice except one. Find it in O(n) time and O(1) space.", "XOR everything: pairs cancel out (x ^ x = 0), leaving the single number.", [T.hash]),
    p(1, T.dfs, "Return the maximum depth of a binary tree.", "depth(node) = 1 + max(depth(left), depth(right)): a natural recursive DFS.", [T.bfs]),
    p(1, T.bfs, "Return the values of a binary tree level by level, top to bottom.", "A queue processes nodes in exactly level order.", []),
    p(1, T.dp, "Count the ways to climb n stairs taking 1 or 2 steps at a time.", "ways(n) = ways(n−1) + ways(n−2): overlapping subproblems.", []),
    p(1, T.fast, "Find the middle node of a linked list in a single pass.", "Move slow by one and fast by two. When fast reaches the end, slow is in the middle.", []),
    p(1, T.two, "Remove duplicates from a sorted array in place and return the new length.", "A write pointer trails a read pointer and copies only new values.", []),
    p(1, T.hash, "Decide whether two strings are anagrams of each other.", "Compare character counts with a hash map (or a 26-slot array).", []),
    p(1, T.stack, "Implement the undo button of a text editor.", "Undo pops the most recent action: last in, first out.", []),
    p(1, T.greedy, "Given coin values 1, 5, 10, 25, make change with the fewest coins.", "For this canonical coin system, always taking the largest coin that fits is optimal.", [T.dp]),

    /* ---------- Medium ---------- */
    p(2, T.slide, "Find the length of the longest substring without repeating characters.", "Grow the window to the right, and shrink from the left whenever a character repeats.", [T.hash, T.two]),
    p(2, T.heap, "Continuously report the k-th largest value in a stream of numbers.", "Keep a min-heap of size k; its top is the k-th largest.", []),
    p(2, T.heap, "Return the k most frequent elements of an array.", "Count with a hash map, then keep a size-k heap keyed by frequency.", [T.hash, T.qsel]),
    p(2, T.dfs, "Count the islands of 1s in a grid of 0s and 1s.", "Flood-fill each unvisited land cell and count how many fills you start.", [T.bfs, T.uf]),
    p(2, T.topo, "Given course prerequisites, decide whether every course can be finished.", "Courses and prerequisites form a directed graph. They are finishable exactly when it has no cycle, so a topological sort succeeds.", [T.dfs]),
    p(2, T.intervals, "Merge all overlapping intervals in a list.", "Sort by start, then extend the last merged interval or start a new one.", []),
    p(2, T.heap, "Find the minimum number of meeting rooms needed for a list of meetings.", "Sort by start and keep a min-heap of end times. Its size is the number of rooms in use.", [T.intervals]),
    p(2, T.mstack, "For each day's temperature, find how many days until a warmer one.", "Keep a stack of unresolved days with decreasing temperatures. A warmer day resolves everything colder on top.", []),
    p(2, T.dp, "Find the minimum number of coins to make an amount, for any set of coin values.", "best(a) = 1 + min over coins of best(a − coin). Greedy fails for sets like {1, 3, 4}.", [T.bfs]),
    p(2, T.back, "Generate every permutation of a list.", "Choose an unused element, recurse, then un-choose it.", []),
    p(2, T.bs, "Search for a value in a sorted array that has been rotated at an unknown pivot.", "At every mid, one half is still sorted. Check whether the target lies in that half.", []),
    p(2, T.prefix, "Count subarrays whose sum equals k. The array contains negative numbers.", "Running sum + a hash map of how often each prefix sum has appeared. A sliding window fails because of the negatives.", [T.hash]),
    p(2, T.back, "Decide whether a word can be traced through adjacent letters of a grid without reusing a cell.", "DFS from each cell, mark the path, and undo the mark on the way back.", [T.dfs]),
    p(2, T.trie, "Build autocomplete: given a prefix, list all stored words that start with it.", "A trie shares prefixes, so you walk to the prefix node and enumerate below it.", []),
    p(2, T.bfs, "Find the fewest moves from the start to the exit of a grid maze.", "In an unweighted graph BFS reaches every cell by the fewest edges first.", []),
    p(2, T.dijk, "Find the cheapest route between two cities when every road has a positive toll.", "Weighted shortest path with non-negative weights.", []),
    p(2, T.hash, "Group a list of words into sets of anagrams.", "Use the sorted letters (or a letter-count tuple) as the hash-map key.", []),
    p(2, T.two, "Choose two vertical lines that hold the most water between them.", "Start at both ends and always move the shorter line inward.", []),
    p(2, T.two, "Find all unique triplets that sum to zero.", "Sort, fix one number, then two-pointer the rest: O(n²).", [T.hash]),
    p(2, T.greedy, "Each array value is the maximum jump length from that index. Can you reach the end?", "Track the farthest reachable index while scanning.", [T.dp]),
    p(2, T.bfs, "Rotten oranges infect neighbours every minute. How many minutes until all are rotten?", "Multi-source BFS starting from every rotten orange at once.", []),
    p(2, T.uf, "An undirected graph had one extra edge added to a tree. Find the edge that creates the cycle.", "Union endpoints edge by edge. The first edge whose endpoints are already joined is the extra one.", [T.dfs]),
    p(2, T.dp, "Count the ways to decode a digit string where 1 = A … 26 = Z.", "ways(i) depends on ways(i−1) and ways(i−2), depending on whether the one- and two-digit codes are valid.", []),
    p(2, T.prefix, "Return an array where each element is the product of all the others, without using division.", "Multiply a prefix-product pass by a suffix-product pass.", []),
    p(2, T.dp, "Find the length of the longest increasing subsequence.", "lis(i) = 1 + max lis(j) over j < i with a[j] < a[i]. Patience sorting makes it O(n log n).", [T.bs]),
    p(2, T.hash, "Find the length of the longest run of consecutive integers in an unsorted array, in O(n).", "Put everything in a set and only start counting from numbers whose predecessor is missing.", []),

    /* ---------- Hard ---------- */
    p(3, T.mdeque, "Return the maximum of every window of size k as it slides across an array, in O(n).", "Keep a deque of indices with decreasing values. The front is always the window max.", [T.heap]),
    p(3, T.mstack, "Find the largest rectangle that fits under a histogram.", "For each bar, a monotonic stack finds the nearest shorter bar on each side.", []),
    p(3, T.two, "Compute how much rain water is trapped between elevation bars, in O(1) extra space.", "Move the side with the lower max inward. Water above a bar is bounded by the smaller side max.", [T.mstack, T.prefix, T.dp]),
    p(3, T.heap, "Maintain the median of a stream of numbers.", "A max-heap for the lower half and a min-heap for the upper half, kept balanced.", []),
    p(3, T.bsa, "Find the minimum eating speed that finishes all banana piles within h hours.", "Feasibility is monotonic in speed, so binary search the speed.", []),
    p(3, T.bsa, "Split an array into m contiguous parts so the largest part's sum is as small as possible.", "Binary search the cap and greedily check whether m parts suffice.", [T.dp]),
    p(3, T.slide, "Find the smallest substring of s containing every character of t.", "Expand until the window is valid, then shrink while it stays valid.", [T.hash, T.two]),
    p(3, T.bfs, "Transform one word into another, changing one letter at a time through a dictionary, in the fewest steps.", "Words are nodes, one-letter changes are edges, and the graph is unweighted.", []),
    p(3, T.topo, "Given words sorted in an alien language, recover the order of its alphabet.", "Adjacent words give \"letter a comes before letter b\" edges. Topologically sort them.", [T.dfs]),
    p(3, T.uf, "Merge user accounts that share at least one email address.", "Union accounts through their shared emails.", [T.dfs]),
    p(3, T.dp, "Find the minimum number of inserts, deletes and replaces to turn one word into another.", "Edit distance: dp[i][j] from dp[i−1][j], dp[i][j−1] and dp[i−1][j−1].", []),
    p(3, T.seg, "Support both \"update a[i]\" and \"sum of a[l..r]\" in O(log n) each.", "Prefix sums break on updates. A Fenwick or segment tree handles both.", []),
    p(3, T.seg, "For each element, count the smaller elements to its right.", "Scan from the right and query a Fenwick tree of the values seen so far.", [T.dc]),
    p(3, T.qsel, "Find the k-th largest element in average O(n) time.", "Partition like quicksort but recurse into one side only.", []),
    p(3, T.dijk, "A signal starts at one node of a weighted network. How long until every node receives it?", "Single-source shortest paths. The answer is the largest distance.", [T.bf]),
    p(3, T.bf, "Find the cheapest flight from A to B using at most k stops.", "Run k+1 rounds of edge relaxation. Each round allows one more edge.", [T.bfs, T.dp]),
    p(3, T.back, "Place n queens on an n×n board so that none attack each other.", "Place row by row, prune unsafe columns and diagonals, and undo on the way back.", []),
    p(3, T.dp, "Implement regular-expression matching with '.' and '*'.", "dp[i][j]: does s[i:] match p[j:]? The '*' either skips or consumes a character.", [T.back]),
    p(3, T.dp, "Find the longest palindromic substring.", "dp[i][j] = s[i] == s[j] and dp[i+1][j−1]. Expanding around each center also works in O(n²).", [T.two]),
    p(3, T.fast, "An array of n+1 numbers in 1..n has one duplicate. Find it in O(1) space without modifying the array.", "Treat i → a[i] as a linked list. The duplicate is the start of the cycle.", [T.bs, T.bits]),
    p(3, T.greedy, "Schedule CPU tasks with a cooldown between identical tasks, minimising total time.", "The most frequent task dictates the frame. Fill the idle slots with the others.", [T.heap]),
    p(3, T.dp, "Find the contiguous subarray with the largest sum.", "Kadane: best ending here = max(x, x + best ending at the previous index).", [T.greedy, T.dc]),
    p(3, T.hash, "Design an LRU cache with O(1) get and put.", "A hash map to nodes of a doubly linked list ordered by recency.", []),

    /* ---------- Expert ---------- */
    p(4, T.dp, "Burst balloons to maximise coins, where bursting i earns left × i × right.", "Interval DP: choose the last balloon to burst in each range.", []),
    p(4, T.bfs, "Find the shortest walk that visits every node of a small graph (n ≤ 12).", "BFS over (node, visited-mask) states.", [T.bits, T.dp]),
    p(4, T.dc, "Count the inversions in an array in O(n log n).", "Merge sort counts the cross pairs while merging.", [T.seg]),
    p(4, T.uf, "Connect all cities with the minimum total cable length.", "Kruskal: sort edges and add each one unless Union-Find says it closes a cycle.", [T.greedy, T.heap]),
    p(4, T.dfs, "Find the strongly connected components of a directed graph.", "Tarjan's or Kosaraju's algorithm, both built on DFS.", []),
    p(4, T.heap, "Find the smallest range that includes at least one number from each of k sorted lists.", "Keep one pointer per list in a min-heap and track the current maximum.", [T.slide, T.two]),
    p(4, T.trie, "Find the maximum XOR of any two numbers in an array.", "Insert the binary forms into a bitwise trie. For each number, greedily walk the opposite bits.", [T.bits]),
    p(4, T.stack, "Find the length of the longest valid parentheses substring.", "Push indices; the index on the stack after a pop marks where the current valid run starts.", [T.dp]),
    p(4, T.mstack, "Sum the minimum of every subarray.", "For each element, a monotonic stack finds how many subarrays it is the minimum of.", [T.dp]),
    p(4, T.heap, "Reach a destination with the fewest refuelling stops, given stations along the road.", "Pass stations, remembering their fuel in a max-heap. Take the biggest only when you run dry.", [T.dp, T.greedy]),
    p(4, T.bs, "Nest the most envelopes inside one another (both sides strictly larger).", "Sort by width ascending and height descending, then find the LIS of heights with binary search.", [T.dp]),
    p(4, T.heap, "Compute the skyline outline from a list of rectangular buildings.", "Sweep the x-events and keep the active heights in a max-heap.", [T.seg, T.intervals, T.dc]),
    p(4, T.dc, "Count range sums that fall within [lower, upper].", "Merge sort on prefix sums counts the valid pairs during the merge.", [T.seg, T.prefix]),
    p(4, T.dp, "Solve the travelling salesman problem exactly for n ≤ 16 cities.", "Held–Karp: dp[mask][last], O(n² · 2ⁿ).", [T.bits, T.back]),
    p(4, T.dijk, "Swim from the top-left to the bottom-right of a grid of rising water levels as early as possible.", "Minimise the maximum cell on the path with a Dijkstra-style min-heap.", [T.bsa, T.uf, T.bfs, T.heap]),
    p(4, T.mdeque, "Find the shortest subarray with sum at least K, where values can be negative.", "Prefix sums plus a deque of increasing prefix values.", [T.prefix]),
    p(4, T.dfs, "Find every bridge, an edge whose removal disconnects the graph.", "Tarjan's low-link values from a DFS tree.", []),
    p(4, T.dp, "Find the cheapest order to multiply a chain of matrices.", "Interval DP over split points.", []),
    p(4, T.bits, "Count the 1 bits of every number from 0 to n in O(n).", "bits[i] = bits[i >> 1] + (i & 1).", [T.dp]),
    p(4, T.bsa, "Find the k-th smallest element in an n×n matrix whose rows and columns are sorted.", "Binary search a value, counting entries ≤ it with a staircase walk.", [T.heap]),
    p(4, T.dp, "Partition an array into two subsets with equal sums.", "Subset-sum DP over achievable sums up to total/2.", [T.bits, T.back]),
  ];

  function make(level, count) {
    return D.drawFromBank("patterns", BANK, level, count).map((b) => {
      const banned = new Set([b.a, ...b.alt]);
      const options = U.shuffle([b.a, ...U.sample(ALL.filter((t) => !banned.has(t)), 3)]);
      return {
        kind: "choice",
        tag: "Pattern",
        prompt: `<p class="problem">${U.esc(b.text)}</p><p class="muted">Which technique is the best fit?</p>`,
        options,
        mono: false,
        answer: b.a,
        explain: U.esc(b.why) + (b.alt.length ? ` <span class="muted">Also workable: ${b.alt.map(U.esc).join(", ")}.</span>` : ""),
        key: b.key,
        bank: b.bank,
        review: U.esc(b.text),
      };
    });
  }

  D.registerMode({
    id: "patterns",
    name: "Pattern Spotter",
    group: "Drills",
    topic: "Problem solving",
    blurb: "Read an interview problem and name the technique that cracks it.",
    bankSize: BANK.length,
    count: 10,
    make,
  });
})();
