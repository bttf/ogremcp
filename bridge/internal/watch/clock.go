package watch

import "time"

// clock makes the watcher's timers. Tests use a fake one.
type clock interface {
	// AfterFunc calls f on its own goroutine after d.
	AfterFunc(d time.Duration, f func()) timer
}

type timer interface {
	Stop() bool
}

type realClock struct{}

func (realClock) AfterFunc(d time.Duration, f func()) timer { return time.AfterFunc(d, f) }
