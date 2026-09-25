package upload

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/watch"
)

// maxAnswer is the most bytes of an answer the bridge reads.
const maxAnswer = 64 << 10

// maxMessage is the most bytes of a server message the bridge keeps.
const maxMessage = 500

// action is what an attempt's result does with the instance's pending
// upload.
type action int

const (
	// taken: stored or duplicate. The upload is done.
	taken action = iota
	// refused: the server refuses these bytes. The upload is done.
	refused
	// gone: the file no longer exists. The upload is done; the watcher
	// reports the file when it is written again.
	gone
	// retry: try again after a backoff.
	retry
	// stop: device_limit. The instance waits for Resume.
	stop
	// login: the login ended. Every upload waits for Resume.
	login
)

// result is the result of one attempt.
type result struct {
	action action
	// status is the §8.3 status, or "" without one.
	status string
	// message is the instance's error: a sentence for the user.
	message string
	// retryAfter is a 429's Retry-After.
	retryAfter time.Duration
	// counter is the error counter the attempt adds one to, or "".
	counter string
	// detail is a retry's error, for the debug log.
	detail string
}

// meta is the `meta` part (§8.3).
type meta struct {
	Kit      string     `json:"kit"`
	SourceID string     `json:"source_id"`
	Instance string     `json:"instance"`
	SHA256   string     `json:"sha256"`
	MTime    string     `json:"mtime,omitempty"`
	Client   clientMeta `json:"client"`
}

type clientMeta struct {
	BridgeVersion string         `json:"bridge_version"`
	OS            string         `json:"os"`
	Errors        map[string]int `json:"errors"`
}

// answer is the ingest route's answer (§8.3).
type answer struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

var errTooLarge = errors.New("over the upload cap")

// attempt uploads the file of change c once, with the error counts.
func (u *Uploader) attempt(ctx context.Context, c watch.Change, counts map[string]int) result {
	data, err := readCapped(c.Path, u.maxBytes)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return result{action: gone}
	case errors.Is(err, errTooLarge):
		return result{action: refused, status: "too_large",
			message: fmt.Sprintf("The file is over %s, the most the bridge uploads. It was not uploaded.", size(u.maxBytes))}
	case err != nil:
		return result{action: retry, counter: ReadFailed, detail: err.Error(),
			message: "Could not read the file. The bridge will try again."}
	}
	body, contentType, err := u.body(c, data, counts)
	if err != nil {
		return result{action: refused, message: "Could not build the upload: " + err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.url, bytes.NewReader(body))
	if err != nil {
		return result{action: refused, message: "Could not build the upload: " + err.Error()}
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	res, err := u.api.Do(req)
	if errors.Is(err, auth.ErrLoginRequired) {
		return result{action: login}
	}
	if err != nil {
		// No answer: the network, the server, or a write error after the
		// server closed the connection early.
		return result{action: retry, counter: UploadFailed, detail: err.Error(),
			message: "Could not reach the server. The bridge will try again."}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, maxAnswer))
	var a answer
	_ = json.Unmarshal(raw, &a)
	return u.classify(res.StatusCode, res.Header.Get("Retry-After"), a)
}

// classify maps an answer to a result (§8.3). An answer counts as its status
// only with the HTTP status the contract gives it, so a proxy's error page is
// not read as the server's.
func (u *Uploader) classify(code int, retryAfter string, a answer) result {
	switch {
	case code == http.StatusCreated && a.Status == "stored",
		code == http.StatusOK && a.Status == "duplicate":
		return result{action: taken, status: a.Status}
	case code == http.StatusUnprocessableEntity && a.Status == "parse_error":
		return result{action: refused, status: a.Status, message: message(a.Message, "The server could not read the file.")}
	case code == http.StatusUnprocessableEntity && a.Status == "unsupported_flavor":
		return result{action: refused, status: a.Status, message: message(a.Message, "This game version isn't supported yet.")}
	case code == http.StatusRequestEntityTooLarge:
		return result{action: refused, status: "too_large", message: message(a.Message, "The file is over the server's size limit.")}
	case code == http.StatusBadRequest && a.Status == "bad_request":
		return result{action: refused, status: a.Status, message: "The server refused the upload as malformed: " + message(a.Message, "no reason given.")}
	case code == http.StatusForbidden && a.Status == "device_limit":
		return result{action: stop, status: a.Status, message: message(a.Message, "Another of your devices uploads for this account.")}
	case code == http.StatusTooManyRequests:
		return result{action: retry, status: "rate_limited", retryAfter: u.retryAfter(retryAfter), detail: "rate limited"}
	case code == http.StatusUnauthorized:
		// auth.Client answers a 401 with ErrLoginRequired; another Doer
		// may pass it on.
		return result{action: login}
	default:
		return result{action: retry, counter: UploadFailed, detail: fmt.Sprintf("status %d", code),
			message: fmt.Sprintf("The server answered with status %d. The bridge will try again.", code)}
	}
}

// body builds the request's body, `meta` first, and returns it with its
// content type.
func (u *Uploader) body(c watch.Change, data []byte, counts map[string]int) ([]byte, string, error) {
	sum := sha256.Sum256(data)
	m := meta{
		Kit:      c.Kit,
		SourceID: c.SourceID,
		Instance: c.Instance,
		SHA256:   hex.EncodeToString(sum[:]),
		Client:   clientMeta{BridgeVersion: u.version, OS: runtime.GOOS, Errors: counts},
	}
	if !c.ModTime.IsZero() {
		m.MTime = c.ModTime.UTC().Format(time.RFC3339)
	}
	metaJSON, err := json.Marshal(m)
	if err != nil {
		return nil, "", err
	}
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	if err := mw.WriteField("meta", string(metaJSON)); err != nil {
		return nil, "", err
	}
	fw, err := mw.CreateFormFile("file", "upload.gz")
	if err != nil {
		return nil, "", err
	}
	gz := gzip.NewWriter(fw)
	if _, err := gz.Write(data); err != nil {
		return nil, "", err
	}
	if err := gz.Close(); err != nil {
		return nil, "", err
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return b.Bytes(), mw.FormDataContentType(), nil
}

// readCapped reads the file at path, or returns errTooLarge when it has more
// than maxBytes bytes.
func readCapped(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errTooLarge
	}
	return data, nil
}

// retryAfter reads a Retry-After header: seconds or an HTTP date.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/ingest/ingest.go:271-290.
func (u *Uploader) retryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	var d time.Duration
	if secs, err := strconv.Atoi(v); err == nil {
		d = time.Duration(secs) * time.Second
	} else if at, err := http.ParseTime(v); err == nil {
		d = at.Sub(u.now())
	}
	return max(0, min(d, u.maxRetryAfter))
}

// message is a server message, cut to maxMessage bytes, or fallback when it
// is empty.
func message(msg, fallback string) string {
	msg = strings.TrimSpace(strings.ToValidUTF8(msg, ""))
	if msg == "" {
		return fallback
	}
	if len(msg) > maxMessage {
		cut := maxMessage
		for cut > 0 && !utf8.RuneStart(msg[cut]) {
			cut--
		}
		msg = msg[:cut] + "…"
	}
	return msg
}

// size writes a byte count for the user, in MB when it is whole.
func size(n int64) string {
	if n%(1<<20) == 0 {
		return fmt.Sprintf("%d MB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}
