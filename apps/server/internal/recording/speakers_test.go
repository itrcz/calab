package recording

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestMatchSpeakers(t *testing.T) {
	a, b, n := uuid.New(), uuid.New(), uuid.New()
	sp := func(u uuid.UUID, s, e int64) speechSpan { return speechSpan{User: u, Start: s * 100, End: e * 100} }
	sg := func(k int, s, e int64) matchSegment { return matchSegment{Speaker: k, Start: s * 100, End: e * 100} }
	// Alternating short remarks of A and B (tenths of a second): 1.5 s each, 0.5 s apart.
	var altSegs []matchSegment
	var altSpeech []speechSpan
	for i := range int64(12) {
		u, k := a, 0
		if i%2 == 1 {
			u, k = b, 1
		}
		altSegs = append(altSegs, sg(k, i*20, i*20+15))
		altSpeech = append(altSpeech, sp(u, i*20+12, i*20+27)) // the reports 1.2 s late
	}
	tests := []struct {
		name       string
		in         matchInput
		speakers   map[int]speakerMatch
		segments   []uuid.UUID // nil = not checked
		wantOffset *int64
	}{
		{
			name: "clean 1:1",
			in: matchInput{
				Segments: []matchSegment{sg(0, 0, 50), sg(1, 60, 100), sg(0, 110, 150), sg(1, 160, 200)},
				Speech:   []speechSpan{sp(a, 0, 50), sp(b, 61, 100), sp(a, 110, 149), sp(b, 160, 200)},
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}},
			segments: []uuid.UUID{a, b, a, b},
		},
		{
			name: "one voice split into two numbers",
			in: matchInput{
				Segments: []matchSegment{sg(0, 0, 50), sg(2, 55, 90), sg(1, 100, 150), sg(0, 160, 200)},
				Speech:   []speechSpan{sp(a, 0, 90), sp(b, 100, 150), sp(a, 160, 200)},
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}, 2: {User: a}},
		},
		{
			name: "two people merged into one number: per remark",
			in: matchInput{
				Segments: []matchSegment{sg(0, 0, 50), sg(0, 60, 100), sg(0, 110, 150), sg(0, 160, 200)},
				Speech:   []speechSpan{sp(a, 0, 50), sp(b, 60, 100), sp(a, 110, 150), sp(b, 160, 200)},
			},
			speakers: map[int]speakerMatch{},
			segments: []uuid.UUID{a, b, a, b},
		},
		{
			name: "remarks without a number",
			in: matchInput{
				Segments: []matchSegment{sg(0, 0, 50), sg(-1, 60, 70), sg(1, 80, 120), sg(-1, 130, 135)},
				Speech:   []speechSpan{sp(a, 0, 50), sp(b, 60, 70), sp(b, 80, 120)},
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}},
			segments: []uuid.UUID{a, b, b, uuid.Nil},
		},
		{
			name: "an always-on client does not take others' numbers",
			in: matchInput{
				Segments: []matchSegment{sg(0, 20, 100), sg(1, 150, 250), sg(0, 300, 380), sg(1, 450, 550)},
				Speech:   []speechSpan{sp(n, 0, 600), sp(a, 20, 100), sp(b, 150, 250), sp(a, 300, 380), sp(b, 450, 550)},
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}},
		},
		{
			name: "two devices of one user",
			in: matchInput{
				Segments: []matchSegment{sg(0, 0, 50), sg(1, 60, 100), sg(0, 110, 150)},
				Speech:   []speechSpan{sp(a, 0, 50), sp(a, 10, 40), sp(b, 60, 100), sp(a, 108, 150), sp(a, 110, 152)},
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}},
		},
		{
			name:       "a 1.2 s shift is found",
			in:         matchInput{Segments: altSegs, Speech: altSpeech},
			speakers:   map[int]speakerMatch{0: {User: a}, 1: {User: b}},
			wantOffset: new(int64(-1200)),
		},
		{
			name: "unmatched stays numbered",
			in: matchInput{
				Segments: []matchSegment{sg(0, 0, 50), sg(1, 60, 100), sg(2, 110, 150)},
				Speech:   []speechSpan{sp(a, 0, 50), sp(b, 60, 100)},
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}},
			segments: []uuid.UUID{a, b, uuid.Nil},
		},
		{
			name: "the one client-less participant gets the only number left",
			in: matchInput{
				Segments:   []matchSegment{sg(0, 0, 50), sg(1, 60, 100), sg(2, 110, 150)},
				Speech:     []speechSpan{sp(a, 0, 50), sp(b, 60, 100)},
				DurationMs: 15000, Clientless: "+79990000000",
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}, 2: {Name: "+79990000000"}},
			segments: []uuid.UUID{a, b, uuid.Nil},
		},
		{
			name: "an employee on an old client and a brief caller: no guess",
			// A reports; B (old client) talks a lot under 1; the caller says a word under 2. Only
			// «one of the notable numbers» would have named B by the phone number.
			in: matchInput{
				Segments:   []matchSegment{sg(0, 0, 50), sg(1, 60, 120), sg(2, 125, 130), sg(0, 135, 150)},
				Speech:     []speechSpan{sp(a, 0, 50), sp(a, 135, 150)},
				DurationMs: 15000, Clientless: "+79990000000",
			},
			speakers: map[int]speakerMatch{0: {User: a}},
			segments: []uuid.UUID{a, uuid.Nil, uuid.Nil, a},
		},
		{
			name: "a stray short number besides the caller's: no guess",
			in: matchInput{
				Segments:   []matchSegment{sg(0, 0, 50), sg(1, 60, 100), sg(2, 110, 150), sg(3, 151, 152)},
				Speech:     []speechSpan{sp(a, 0, 50), sp(b, 60, 100)},
				DurationMs: 15000, Clientless: "+79990000000",
			},
			speakers: map[int]speakerMatch{0: {User: a}, 1: {User: b}},
		},
		{
			name: "two notable numbers left: the client-less rule does not guess",
			in: matchInput{
				Segments:   []matchSegment{sg(0, 0, 50), sg(1, 60, 100), sg(2, 110, 150)},
				Speech:     []speechSpan{sp(a, 0, 50)},
				DurationMs: 15000, Clientless: "+79990000000",
			},
			speakers: map[int]speakerMatch{0: {User: a}},
		},
		{
			name: "no reports at all: the client-less participant alone",
			in: matchInput{
				Segments:   []matchSegment{sg(0, 0, 50)},
				DurationMs: 6000, Clientless: "+79990000000",
			},
			speakers: map[int]speakerMatch{0: {Name: "+79990000000"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := matchSpeakers(tc.in)
			if len(got.Speakers) != len(tc.speakers) {
				t.Fatalf("speakers: got %v, want %v", got.Speakers, tc.speakers)
			}
			for k, want := range tc.speakers {
				if got.Speakers[k] != want {
					t.Fatalf("speaker %d: got %v, want %v (all %v)", k, got.Speakers[k], want, got.Speakers)
				}
			}
			if tc.segments != nil {
				for i, want := range tc.segments {
					if got.Segments[i] != want {
						t.Fatalf("segment %d: got %v, want %v", i, got.Segments[i], want)
					}
				}
			}
			if tc.wantOffset != nil && got.OffsetMs != *tc.wantOffset {
				t.Fatalf("offset: got %d, want %d", got.OffsetMs, *tc.wantOffset)
			}
		})
	}
}

func TestMergeSpeech(t *testing.T) {
	got := mergeSpeech([][2]int64{{5000, 6000}, {0, 1000}, {1300, 2000}, {2600, 3000}, {2900, 3500}, {-500, -100}, {9000, 9000}}, 0, 8000)
	want := [][2]int64{{0, 2000}, {2600, 3500}, {5000, 6000}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// The reports count from started_at, the transcript from the file's start: a file that started
// 1.5 s after started_at sees the same speech 1.5 s earlier; one that started before, later.
func TestSpeechInFileShift(t *testing.T) {
	u := uuid.New()
	started := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	rows := []sqlc.ListRecordingSpeechRow{{UserID: u, StartMs: 5000, EndMs: 8000}}
	for _, tc := range []struct {
		name       string
		file       *time.Time
		start, end int64
	}{
		{"no file start", nil, 5000, 8000},
		{"file started later", new(started.Add(1500 * time.Millisecond)), 3500, 6500},
		{"file started earlier", new(started.Add(-700 * time.Millisecond)), 5700, 8700},
	} {
		got := speechInFile(rows, started, tc.file)
		if len(got) != 1 || got[0].User != u || got[0].Start != tc.start || got[0].End != tc.end {
			t.Fatalf("%s: got %+v, want %d–%d", tc.name, got, tc.start, tc.end)
		}
	}
}

// RECORDING_SPEAKER_NAMES=off: the matcher is skipped before any read of the reports — no
// speakers_json, the segments keep only their numbers.
func TestNameSpeakersOff(t *testing.T) {
	s := &Service{} // no database: an attempt to read the reports would panic
	s.SetSpeakerNames(false)
	zero := 0
	segs := []segment{{Speaker: &zero, Start: 0, End: 5, Text: "hi"}}
	if got := s.nameSpeakers(t.Context(), sqlc.RoomRecording{ID: uuid.New(), StartedAt: time.Now()}, segs); got != nil || segs[0].UserID != "" {
		t.Fatalf("matched with the switch off: %s, %q", got, segs[0].UserID)
	}
}
