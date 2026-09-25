package adapter

import (
	"errors"
	"strconv"
	"strings"
)

// Version is a semantic version, MAJOR.MINOR.PATCH with an optional
// pre-release, as a TOC's ## Version line holds it. Build metadata (+...) is
// not accepted.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/addon/version.go.
type Version struct {
	Major, Minor, Patch int
	// Pre is the pre-release without its dash, such as "beta.1", or "".
	Pre string
}

var errVersion = errors.New("not a version of the form X.Y.Z")

// ParseVersion reads X.Y.Z or X.Y.Z-pre, with an optional leading v.
func ParseVersion(s string) (Version, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	core, pre, hasPre := strings.Cut(s, "-")
	if hasPre && !validPre(pre) {
		return Version{}, errVersion
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Version{}, errVersion
	}
	var n [3]int
	for i, p := range parts {
		if p == "" || len(p) > 9 || strings.Trim(p, "0123456789") != "" || (len(p) > 1 && p[0] == '0') {
			return Version{}, errVersion
		}
		n[i], _ = strconv.Atoi(p)
	}
	return Version{Major: n[0], Minor: n[1], Patch: n[2], Pre: pre}, nil
}

func validPre(pre string) bool {
	for _, id := range strings.Split(pre, ".") {
		if id == "" {
			return false
		}
		for _, r := range id {
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '-') {
				return false
			}
		}
	}
	return true
}

func (v Version) String() string {
	s := strconv.Itoa(v.Major) + "." + strconv.Itoa(v.Minor) + "." + strconv.Itoa(v.Patch)
	if v.Pre != "" {
		s += "-" + v.Pre
	}
	return s
}

// Compare returns -1, 0, or 1 as v is older than, the same as, or newer than
// o, by the rules of semantic versioning: a pre-release is older than its
// release, and pre-release identifiers compare one by one, numbers by value
// and below words.
func (v Version) Compare(o Version) int {
	for _, d := range [3][2]int{{v.Major, o.Major}, {v.Minor, o.Minor}, {v.Patch, o.Patch}} {
		if d[0] != d[1] {
			return sign(d[0] - d[1])
		}
	}
	switch {
	case v.Pre == o.Pre:
		return 0
	case v.Pre == "":
		return 1
	case o.Pre == "":
		return -1
	}
	a, b := strings.Split(v.Pre, "."), strings.Split(o.Pre, ".")
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := compareIdent(a[i], b[i]); c != 0 {
			return c
		}
	}
	return sign(len(a) - len(b))
}

func compareIdent(a, b string) int {
	an, aErr := strconv.Atoi(a)
	bn, bErr := strconv.Atoi(b)
	switch {
	case aErr == nil && bErr == nil:
		return sign(an - bn)
	case aErr == nil:
		return -1
	case bErr == nil:
		return 1
	}
	return strings.Compare(a, b)
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}
