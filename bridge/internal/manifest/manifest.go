// Package manifest is a kit's manifest (docs/architecture.md §6.1): the Go
// types of the SDK's manifest schema, packages/sdk/src/manifest.schema.json,
// and the checks the bridge makes before it uses one.
//
// The bridge gets manifests from the platform (§8.2). Parse checks every rule
// of the schema itself, and these as well:
//
//   - A relative path (root.verify, adapter.install, sources[].path) may not
//     leave root in any form Windows reads as leaving it. Beyond the schema's
//     rules, CheckRelative rejects a segment made only of dots and spaces,
//     other than ".": Windows strips trailing dots and spaces, so it reads
//     ".. " as "..". It also rejects a ":" anywhere, which Windows reads as a
//     drive or a stream. Package locate checks each resolved path again.
//   - A locate path may use a variable only at its start. Each variable holds
//     an absolute folder.
//   - sources[].id is unique, since ingest dedups by it (§8.3).
//   - An adapter.process glob has no "?" or "[", which other glob syntaxes
//     read as wildcards, and no "/" or "\". Here they would be literal, the
//     glob would match no process, and an adapter update could run under a
//     running game (§7).
//
// Fields the schema does not name are ignored.
//
// Paths use the glob syntax that package locate documents: "*" only, within
// one segment. adapter.process globs use it too, and match a process's
// executable name ignoring case (package process).
package manifest

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// The variables a locate path may start with (§6.1).
const (
	VarProgramFilesX86 = "{PROGRAM_FILES_X86}"
	VarHome            = "{HOME}"
)

// Manifest is a kit's manifest.
type Manifest struct {
	// Kit is the kit's ID, such as "wow". It appears in the bridge API's
	// paths (§8.2).
	Kit string `json:"kit"`
	// Version is the kit's version, semver.
	Version string `json:"version"`
	// SDK is the compatible @ogremcp/sdk range.
	SDK        string `json:"sdk"`
	ToolPrefix string `json:"tool_prefix"`
	Root       Root   `json:"root"`
	// Adapter is nil for a kit without an adapter.
	Adapter *Adapter          `json:"adapter,omitempty"`
	Sources []Source          `json:"sources"`
	Flavors map[string]Flavor `json:"flavors"`
}

// Root is how the bridge finds the game's install folder.
type Root struct {
	// Locate is the ordered locate chain.
	Locate []LocateEntry `json:"locate"`
	// Verify is a relative glob that must match under a candidate root.
	Verify string `json:"verify"`
}

// LocateEntry is one entry of the locate chain. Exactly one of Path and
// Prompt is set.
type LocateEntry struct {
	// Path is a candidate install folder, with globs, which may start with a
	// variable.
	Path string `json:"path,omitempty"`
	// Prompt is the title of the folder picker the bridge shows the user.
	Prompt string `json:"prompt,omitempty"`
}

// UnmarshalJSON requires exactly one of path and prompt, as the schema's
// oneOf does.
func (e *LocateEntry) UnmarshalJSON(data []byte) error {
	var raw struct {
		Path   *string `json:"path"`
		Prompt *string `json:"prompt"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if (raw.Path == nil) == (raw.Prompt == nil) {
		return errors.New("a root.locate entry needs exactly one of path and prompt")
	}
	*e = LocateEntry{}
	if raw.Path != nil {
		e.Path = *raw.Path
	} else {
		e.Prompt = *raw.Prompt
	}
	return nil
}

// Adapter is the in-game adapter.
type Adapter struct {
	// Install is where the bridge installs the adapter, relative to root.
	Install string `json:"install"`
	// Process lists globs for the game's process names.
	Process []string `json:"process"`
}

// Source is one kind of thing the bridge reads.
type Source struct {
	// ID is sent as source_id at ingest (§8.3).
	ID      string `json:"id"`
	Type    string `json:"type"`
	Format  string `json:"format"`
	Path    string `json:"path"`
	Trigger string `json:"trigger"`
}

// Flavor is one flavor's config.
type Flavor struct {
	Status string `json:"status"`
}

var (
	snakeCase = regexp.MustCompile(`^[a-z0-9]+(_[a-z0-9]+)*$`)
	semver    = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?$`)
)

// Parse reads a manifest and checks it.
func Parse(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("could not read the kit manifest: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// ValidKit reports whether name is a valid kit ID: lowercase snake_case.
func ValidKit(name string) bool {
	return snakeCase.MatchString(name)
}

// Validate checks m against the schema and the bridge's own rules (see the
// package comment). The error lists every problem.
func (m *Manifest) Validate() error {
	var problems []error
	bad := func(format string, a ...any) {
		problems = append(problems, fmt.Errorf(format, a...))
	}
	if !ValidKit(m.Kit) {
		bad("kit %q is not lowercase snake_case", m.Kit)
	}
	if !semver.MatchString(m.Version) {
		bad("version %q is not a semver version", m.Version)
	}
	if m.SDK == "" {
		bad("sdk is missing")
	}
	if !snakeCase.MatchString(m.ToolPrefix) || len(m.ToolPrefix) > 60 {
		bad("tool_prefix %q is not lowercase snake_case of at most 60 characters", m.ToolPrefix)
	}

	if len(m.Root.Locate) == 0 {
		bad("root.locate is empty")
	}
	for i, e := range m.Root.Locate {
		switch {
		case (e.Path == "") == (e.Prompt == ""):
			bad("root.locate[%d] needs exactly one of path and prompt", i)
		case e.Path != "":
			if err := checkLocatePath(e.Path); err != nil {
				bad("root.locate[%d].path %q %w", i, e.Path, err)
			}
		}
	}
	if err := CheckRelative(m.Root.Verify); err != nil {
		bad("root.verify %q %w", m.Root.Verify, err)
	}

	if a := m.Adapter; a != nil {
		if err := CheckRelative(a.Install); err != nil {
			bad("adapter.install %q %w", a.Install, err)
		}
		if len(a.Process) == 0 || slices.Contains(a.Process, "") {
			bad("adapter.process needs at least one process name, and no empty one")
		}
		for i, p := range a.Process {
			if strings.ContainsAny(p, `?[/\`) {
				bad("adapter.process[%d] %q has a \"?\", \"[\", or separator; a process glob has only \"*\", which matches within the name", i, p)
			}
		}
	}

	if len(m.Sources) == 0 {
		bad("sources is empty")
	}
	ids := map[string]bool{}
	for i, s := range m.Sources {
		switch {
		case s.ID == "":
			bad("sources[%d].id is missing", i)
		case ids[s.ID]:
			bad("sources[%d].id %q is used by an earlier source; ingest dedups by it", i, s.ID)
		}
		ids[s.ID] = true
		if s.Type != "file" {
			bad("sources[%d].type %q is not file", i, s.Type)
		}
		if s.Format != "text" {
			bad("sources[%d].format %q is not text", i, s.Format)
		}
		if s.Trigger != "on_change" {
			bad("sources[%d].trigger %q is not on_change", i, s.Trigger)
		}
		if err := CheckRelative(s.Path); err != nil {
			bad("sources[%d].path %q %w", i, s.Path, err)
		}
	}

	if len(m.Flavors) == 0 {
		bad("flavors is empty")
	}
	for _, name := range slices.Sorted(maps.Keys(m.Flavors)) {
		f := m.Flavors[name]
		if !snakeCase.MatchString(name) || name == "unknown" {
			bad("flavor %q is not lowercase snake_case, or is the reserved unknown", name)
		}
		if f.Status != "supported" && f.Status != "experimental" {
			bad("flavors.%s.status %q is not supported or experimental", name, f.Status)
		}
	}

	if len(problems) > 0 {
		return fmt.Errorf("the manifest of kit %q is not valid: %w", m.Kit, errors.Join(problems...))
	}
	return nil
}

// Segments splits a manifest path into its segments. Both "/" and "\"
// separate segments, on every OS. Empty and "." segments are dropped.
func Segments(path string) []string {
	var segs []string
	for _, s := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if s != "." {
			segs = append(segs, s)
		}
	}
	return segs
}

// CheckRelative checks the text of a relative path: root.verify,
// adapter.install, or sources[].path. It has no variable, and it may not
// leave root: no leading "/" or "\", no ":" (a drive letter or a stream on
// Windows), and no segment made only of dots and spaces other than ".", such
// as ".." or ".. ". It must name something under root. The error completes a
// sentence that starts with the path.
func CheckRelative(path string) error {
	switch {
	case path == "":
		return errors.New("is empty")
	case strings.ContainsAny(path, "{}"):
		return errors.New("has a variable; only a locate path may")
	case path[0] == '/' || path[0] == '\\':
		return errors.New("is absolute; it must be relative to root")
	case strings.Contains(path, ":"):
		return errors.New("has a \":\", which Windows reads as a drive or a stream")
	}
	segs := Segments(path)
	for _, s := range segs {
		if strings.Trim(s, ". ") == "" {
			return fmt.Errorf("has the segment %q, which leaves root on Windows or elsewhere", s)
		}
	}
	if len(segs) == 0 {
		return errors.New("names nothing under root")
	}
	return nil
}

// checkLocatePath checks a locate path's variables. A variable may only start
// the path, followed by a separator or the end, since it holds an absolute
// folder.
func checkLocatePath(path string) error {
	rest := path
	for _, v := range []string{VarProgramFilesX86, VarHome} {
		if after, ok := strings.CutPrefix(path, v); ok {
			if after != "" && after[0] != '/' && after[0] != '\\' {
				return fmt.Errorf("must follow %s with a separator", v)
			}
			rest = after
			break
		}
	}
	if strings.ContainsAny(rest, "{}") {
		return fmt.Errorf("may only start with a variable, %s or %s, and has no other braces", VarProgramFilesX86, VarHome)
	}
	return nil
}
