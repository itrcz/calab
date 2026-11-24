package recording

import (
	"slices"
	"sort"

	"github.com/google/uuid"
)

// Speaker names in transcripts (ADR-0169 §3–4). Recognition numbers the voices of the mixed
// recording (0, 1, …); every client reports when its own microphone was on air. matchSpeakers
// maps the numbers to people from those reports alone — a pure function of times.

// speechSpan is one on-air interval of a participant, in ms of the recording's file.
type speechSpan struct {
	User       uuid.UUID
	Start, End int64
}

// matchSegment is one remark of the transcript: the recognition's speaker number (-1 = none)
// and its time in ms of the file.
type matchSegment struct {
	Speaker    int
	Start, End int64
}

// matchInput is what the matcher works with.
type matchInput struct {
	Segments []matchSegment
	Speech   []speechSpan
	// DurationMs of the recording (the client-less rule's «≥ 10 % of the recording»).
	DurationMs int64
	// Clientless names the one participant without a client who was in the room during the
	// recording (a phone caller); "" = none, or more than one.
	Clientless string
}

// speakerMatch is who a speaker number is: a person (User) or someone named outside the
// directory (Name).
type speakerMatch struct {
	User uuid.UUID
	Name string
}

// matchOutput: Speakers by number (only the identified ones), and the person of every segment
// (uuid.Nil = not identified; a Name-only speaker leaves its segments Nil).
type matchOutput struct {
	Speakers map[int]speakerMatch
	Segments []uuid.UUID
	OffsetMs int64 // the global shift applied to the reports
}

const (
	offsetRangeMs  = 2000 // the reports are shifted by up to ±2 s to fit the transcript
	offsetStepMs   = 100
	minSoloMs      = 3000 // fewer solo ms than this under a number: decide by the overall overlap
	mergedShare    = 0.3  // two people each over 30 % of a number: recognition merged them
	clientlessPart = 0.1  // the client-less participant's number has ≥ 10 % of the recording
)

// piece is an elementary stretch of the timeline with the same people on air.
type piece struct {
	start, end int64
	users      []int // indices into timeline.users, sorted
}

type timeline struct {
	users  []uuid.UUID
	pieces []piece // sorted, non-overlapping, non-empty sets only
	onAir  []int64 // per user: total on-air ms
}

// buildTimeline cuts the reports (shifted by off) into pieces.
func buildTimeline(speech []speechSpan, off int64) *timeline {
	idx := map[uuid.UUID]int{}
	tl := &timeline{}
	type edge struct {
		at   int64
		user int
		d    int
	}
	edges := make([]edge, 0, 2*len(speech))
	for _, s := range speech {
		if s.End <= s.Start {
			continue
		}
		u, ok := idx[s.User]
		if !ok {
			u = len(tl.users)
			idx[s.User] = u
			tl.users = append(tl.users, s.User)
		}
		edges = append(edges, edge{s.Start + off, u, 1}, edge{s.End + off, u, -1})
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].at < edges[j].at })
	tl.onAir = make([]int64, len(tl.users))
	depth := make([]int, len(tl.users)) // a user's devices may overlap: count them
	var active []int
	for i := 0; i < len(edges); {
		at := edges[i].at
		for ; i < len(edges) && edges[i].at == at; i++ {
			e := edges[i]
			was := depth[e.user] > 0
			depth[e.user] += e.d
			switch now := depth[e.user] > 0; {
			case now && !was:
				active = append(active, e.user)
			case !now && was:
				active = slices.DeleteFunc(active, func(u int) bool { return u == e.user })
			}
		}
		if i == len(edges) || len(active) == 0 {
			continue
		}
		next := edges[i].at
		if next <= at {
			continue
		}
		set := slices.Clone(active)
		slices.Sort(set)
		if n := len(tl.pieces); n > 0 && tl.pieces[n-1].end == at && slices.Equal(tl.pieces[n-1].users, set) {
			tl.pieces[n-1].end = next
		} else {
			tl.pieces = append(tl.pieces, piece{start: at, end: next, users: set})
		}
		for _, u := range set {
			tl.onAir[u] += next - at
		}
	}
	return tl
}

// each calls fn for every piece overlapping [a, b) with the overlap's length.
func (tl *timeline) each(a, b int64, fn func(p *piece, ms int64)) {
	i := sort.Search(len(tl.pieces), func(i int) bool { return tl.pieces[i].end > a })
	for ; i < len(tl.pieces) && tl.pieces[i].start < b; i++ {
		p := &tl.pieces[i]
		if ms := min(b, p.end) - max(a, p.start); ms > 0 {
			fn(p, ms)
		}
	}
}

// bestOffset is the shift of the reports (±2 s, 100 ms steps) under which they cover the most
// of the transcript's speech; ties go to the smaller shift.
func bestOffset(segs []matchSegment, speech []speechSpan) int64 {
	tl := buildTimeline(speech, 0)
	if len(tl.pieces) == 0 {
		return 0
	}
	best, bestScore := int64(0), int64(-1)
	for d := int64(0); d <= offsetRangeMs; d += offsetStepMs {
		for _, off := range []int64{d, -d} {
			var score int64
			for _, s := range segs {
				// Shifting the reports by off = shifting the remarks by -off.
				tl.each(s.Start-off, s.End-off, func(_ *piece, ms int64) { score += ms })
			}
			if score > bestScore {
				best, bestScore = off, score
			}
			if d == 0 {
				break
			}
		}
	}
	return best
}

// scores of a set of remarks against the people.
type scores struct {
	dur     int64   // the remarks' speech
	solo    []int64 // per user: ms when only they were on air
	over    []int64 // per user: ms when they were on air
	soloSum int64
}

func (tl *timeline) score(segs []matchSegment) scores {
	sc := scores{solo: make([]int64, len(tl.users)), over: make([]int64, len(tl.users))}
	for _, s := range segs {
		if s.End <= s.Start {
			continue
		}
		sc.dur += s.End - s.Start
		tl.each(s.Start, s.End, func(p *piece, ms int64) {
			if len(p.users) == 1 {
				sc.solo[p.users[0]] += ms
				sc.soloSum += ms
			}
			for _, u := range p.users {
				sc.over[u] += ms
			}
		})
	}
	return sc
}

// top2 returns the index and value of the largest and the second value.
func top2(v []float64) (int, float64, float64) {
	bi, b1, b2 := -1, 0.0, 0.0
	for i, x := range v {
		switch {
		case x > b1:
			bi, b1, b2 = i, x, b1
		case x > b2:
			b2 = x
		}
	}
	return bi, b1, b2
}

// decide picks the person of a set of remarks (-1 = undecided): the one covering ≥ 50 % of the
// speech and twice as much as anyone else — by the solo stretches first (only one person on
// air: a client reporting itself on air all the time gets none while others speak), else by
// the overall overlap weighted by how much of the person's on-air time falls into these
// remarks (an always-on client covers everything but concentrates on nothing).
func (tl *timeline) decide(sc scores, minSolo int64) int {
	if sc.dur <= 0 {
		return -1
	}
	half := float64(sc.dur) / 2
	if sc.soloSum >= minSolo {
		v := make([]float64, len(sc.solo))
		for i, x := range sc.solo {
			v[i] = float64(x)
		}
		if u, s1, s2 := top2(v); u >= 0 && s1 >= half && s1 >= 2*s2 {
			return u
		}
	}
	v := make([]float64, len(sc.over))
	for i, x := range sc.over {
		if tl.onAir[i] > 0 {
			v[i] = float64(x) * float64(x) / float64(tl.onAir[i])
		}
	}
	if u, s1, s2 := top2(v); u >= 0 && float64(sc.over[u]) >= half && s1 >= 2*s2 {
		return u
	}
	return -1
}

// merged reports that two people each cover ≥ 30 % of the speech.
func (sc scores) merged() bool {
	n := 0
	for _, x := range sc.over {
		if float64(x) >= mergedShare*float64(sc.dur) {
			n++
		}
	}
	return n >= 2
}

// matchSpeakers maps the transcript's speaker numbers to people (ADR-0169 §4).
func matchSpeakers(in matchInput) matchOutput {
	out := matchOutput{Speakers: map[int]speakerMatch{}, Segments: make([]uuid.UUID, len(in.Segments))}
	byNum := map[int][]int{} // speaker number → its remarks
	var nums []int
	for i, s := range in.Segments {
		if _, ok := byNum[s.Speaker]; !ok && s.Speaker >= 0 {
			nums = append(nums, s.Speaker)
		}
		byNum[s.Speaker] = append(byNum[s.Speaker], i)
	}
	slices.Sort(nums)
	pick := func(ids []int) []matchSegment {
		segs := make([]matchSegment, len(ids))
		for j, i := range ids {
			segs[j] = in.Segments[i]
		}
		return segs
	}
	one := func(tl *timeline, i int) int {
		s := in.Segments[i]
		return tl.decide(tl.score([]matchSegment{s}), min(minSoloMs, (s.End-s.Start)/2))
	}
	unresolved := map[int]bool{}
	if len(in.Speech) > 0 {
		out.OffsetMs = bestOffset(in.Segments, in.Speech)
		tl := buildTimeline(in.Speech, out.OffsetMs)
		for _, n := range nums {
			ids := byNum[n]
			sc := tl.score(pick(ids))
			if u := tl.decide(sc, minSoloMs); u >= 0 {
				out.Speakers[n] = speakerMatch{User: tl.users[u]}
				for _, i := range ids {
					out.Segments[i] = tl.users[u]
				}
				continue
			}
			if sc.merged() { // one number, two people: remark by remark
				for _, i := range ids {
					if u := one(tl, i); u >= 0 {
						out.Segments[i] = tl.users[u]
					}
				}
				continue
			}
			unresolved[n] = true
		}
		for _, i := range byNum[-1] { // remarks without a number: each by its own overlap
			if u := one(tl, i); u >= 0 {
				out.Segments[i] = tl.users[u]
			}
		}
	} else {
		for _, n := range nums {
			unresolved[n] = true
		}
	}
	// The one participant without a client gets the one remaining number with notable speech.
	if in.Clientless != "" && in.DurationMs > 0 {
		cand, count := -1, 0
		for n := range unresolved {
			var ms int64
			for _, s := range pick(byNum[n]) {
				ms += max(s.End-s.Start, 0)
			}
			if float64(ms) >= clientlessPart*float64(in.DurationMs) {
				cand, count = n, count+1
			}
		}
		if count == 1 {
			out.Speakers[cand] = speakerMatch{Name: in.Clientless}
		}
	}
	return out
}
