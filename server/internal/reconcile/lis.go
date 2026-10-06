package reconcile

// longestIncreasingSubsequence returns the indices into seq belonging to
// one longest strictly increasing subsequence (doc 07 §8). Ties keep the
// earliest candidates, which preserves the current relative order of as
// many existing siblings as possible.
func longestIncreasingSubsequence(seq []int) []int {
	if len(seq) == 0 {
		return nil
	}
	n := len(seq)
	// tails[i] = index into seq of the smallest tail of an increasing
	// subsequence of length i+1; prev chains the reconstructed path.
	tails := make([]int, 0, n)
	prev := make([]int, n)
	for i, v := range seq {
		// Binary search for the first tail whose value is >= v.
		lo, hi := 0, len(tails)
		for lo < hi {
			mid := (lo + hi) / 2
			if seq[tails[mid]] < v {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo > 0 {
			prev[i] = tails[lo-1]
		} else {
			prev[i] = -1
		}
		if lo == len(tails) {
			tails = append(tails, i)
		} else {
			tails[lo] = i
		}
	}
	out := make([]int, 0, len(tails))
	for i := tails[len(tails)-1]; i >= 0; i = prev[i] {
		out = append(out, i)
	}
	for l, r := 0, len(out)-1; l < r; l, r = l+1, r-1 {
		out[l], out[r] = out[r], out[l]
	}
	return out
}
