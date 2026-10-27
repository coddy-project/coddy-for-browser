#!/usr/bin/env bash
# security-scan.sh - the repository's security gate, the same one in CI
# (.github/workflows/security.yaml) and on a developer's machine
# (`npm run security`):
#   - trivy:   vulnerable dependencies (package-lock.json), committed
#              secrets, misconfiguration;
#   - semgrep: static analysis of the extension, the scripts and the tests
#              (JavaScript rules, secrets, GitHub Actions);
#   - zizmor:  the workflows under .github: injection through expressions,
#              unpinned actions, dangerous triggers, leaked credentials;
#   - amo:     the validator addons.mozilla.org runs on every submission
#              (web-ext lint) over a fresh Firefox build.
#
# Runner per scanner: a binary on PATH first, then a docker image pinned by
# tag and digest (GitHub's ubuntu runners ship docker). The AMO validator is
# the web-ext of package-lock.json: run `npm ci --ignore-scripts` first.
#
# Knobs (env):
#   SEC_SCANNERS      comma list: trivy,semgrep,zizmor,amo (default: all four)
#   SEC_FAIL_TRIVY    UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL|off (default: HIGH;
#                     vulnerabilities and secrets, misconfig is report-only)
#   SEC_FAIL_SEMGREP  INFO|WARNING|ERROR|off (default: WARNING)
#   SEC_FAIL_ZIZMOR   informational|low|medium|high|off (default: low)
#   SEC_FAIL_AMO      warning|error|off (default: error)
#   SEC_DOCKER        0|1 allow the docker fallback (default: 1)
#   SEMGREP_CONFIGS   space-separated semgrep --config values
#                     (default: "p/javascript p/secrets p/github-actions")
#   GH_TOKEN          optional; lets zizmor run its online audits (known
#                     vulnerable actions, impostor commits); CI sets it
#
# Reports land in dist/security/: trivy.json, trivy.sarif, semgrep.json,
# semgrep.sarif, zizmor.json, zizmor.sarif, amo.json, summary.md. The SARIF
# files leave secret findings out (code scanning keeps the matched text).
#
# Exit code: 0 when every requested scan ran and the gate is clean; 1 on a
# gate failure or when a scan could not run; 2 on a bad knob.
set -uo pipefail

log() { printf 'security-scan: %s\n' "$*" >&2; }

# Pinned images: tag@sha256. Bump the tag and the digest together.
TRIVY_IMAGE="aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
SEMGREP_IMAGE="semgrep/semgrep:1.177.0@sha256:acaac22ffc7b7cc5926de0751b223bce0b2491c33d18422fa72f632c78d81198"
ZIZMOR_IMAGE="ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"

SEC_SCANNERS="${SEC_SCANNERS:-trivy,semgrep,zizmor,amo}"
SEC_FAIL_TRIVY="${SEC_FAIL_TRIVY:-HIGH}"
SEC_FAIL_SEMGREP="${SEC_FAIL_SEMGREP:-WARNING}"
SEC_FAIL_ZIZMOR="${SEC_FAIL_ZIZMOR:-low}"
SEC_FAIL_AMO="${SEC_FAIL_AMO:-error}"
SEC_DOCKER="${SEC_DOCKER:-1}"
SEMGREP_CONFIGS="${SEMGREP_CONFIGS:-p/javascript p/secrets p/github-actions}"

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || { log "cannot cd to $root"; exit 1; }

OUT="dist/security"
mkdir -p "$OUT/.cache/trivy" "$OUT/.cache/semgrep-home" || { log "cannot create $OUT"; exit 1; }

want() {
  case ",$SEC_SCANNERS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- knobs: a typo must not pass for a clean gate ---
case "$SEC_FAIL_TRIVY" in UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL|off) ;; *)
  log "unknown SEC_FAIL_TRIVY='$SEC_FAIL_TRIVY' (want UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL|off)"; exit 2 ;; esac
case "$SEC_FAIL_SEMGREP" in INFO|WARNING|ERROR|off) ;; *)
  log "unknown SEC_FAIL_SEMGREP='$SEC_FAIL_SEMGREP' (want INFO|WARNING|ERROR|off)"; exit 2 ;; esac
case "$SEC_FAIL_ZIZMOR" in informational|low|medium|high|off) ;; *)
  log "unknown SEC_FAIL_ZIZMOR='$SEC_FAIL_ZIZMOR' (want informational|low|medium|high|off)"; exit 2 ;; esac
case "$SEC_FAIL_AMO" in warning|error|off) ;; *)
  log "unknown SEC_FAIL_AMO='$SEC_FAIL_AMO' (want warning|error|off)"; exit 2 ;; esac
case "$SEC_DOCKER" in 0|1) ;; *)
  log "unknown SEC_DOCKER='$SEC_DOCKER' (want 0|1)"; exit 2 ;; esac
known=0
old_ifs=$IFS; IFS=','
for s in $SEC_SCANNERS; do
  case "$s" in
    trivy|semgrep|zizmor|amo) known=1 ;;
    *) log "unknown scanner '$s' in SEC_SCANNERS (want trivy,semgrep,zizmor,amo)"; IFS=$old_ifs; exit 2 ;;
  esac
done
IFS=$old_ifs
[ "$known" -eq 1 ] || { log "SEC_SCANNERS='$SEC_SCANNERS' selects no scanner"; exit 2; }
command -v python3 >/dev/null 2>&1 || { log "python3 not found - the gate counter needs it"; exit 1; }

status=0
pulls=()

# run_with <name> <binary> <image> [docker args...] sets RUN to the command
# prefix of a scanner: its binary, else its pinned image.
docker_ok() { [ "$SEC_DOCKER" = "1" ] && command -v docker >/dev/null 2>&1; }

if want trivy; then
  if command -v trivy >/dev/null 2>&1; then
    TRIVY_RUN=(trivy)
  elif docker_ok; then
    TRIVY_RUN=(docker run --rm --user "$(id -u):$(id -g)" -e TRIVY_CACHE_DIR=/cache/trivy
      -v "$root:/src" -w /src -v "$root/$OUT/.cache:/cache" "$TRIVY_IMAGE")
    pulls+=("$TRIVY_IMAGE")
  else
    log "trivy: no binary on PATH and no docker fallback"; status=1
  fi
fi
if want semgrep; then
  if command -v semgrep >/dev/null 2>&1; then
    SEMGREP_RUN=(semgrep)
  elif docker_ok; then
    SEMGREP_RUN=(docker run --rm --user "$(id -u):$(id -g)" -e HOME=/cache/semgrep-home
      -v "$root:/src" -w /src -v "$root/$OUT/.cache:/cache" "$SEMGREP_IMAGE" semgrep)
    pulls+=("$SEMGREP_IMAGE")
  else
    log "semgrep: no binary on PATH and no docker fallback"; status=1
  fi
fi
if want zizmor; then
  if command -v zizmor >/dev/null 2>&1; then
    ZIZMOR_RUN=(zizmor)
  elif docker_ok; then
    ZIZMOR_RUN=(docker run --rm --user "$(id -u):$(id -g)" -e GH_TOKEN
      -v "$root:/src:ro" -w /src "$ZIZMOR_IMAGE")
    pulls+=("$ZIZMOR_IMAGE")
  else
    log "zizmor: no binary on PATH and no docker fallback"; status=1
  fi
fi
if want amo && [ ! -x node_modules/.bin/web-ext ]; then
  log "amo: node_modules/.bin/web-ext is missing, run npm ci --ignore-scripts first"; status=1
fi
[ "$status" -eq 0 ] || exit 1

# A stale local image must not diverge from the one CI pulls.
for img in "${pulls[@]}"; do
  docker pull -q "$img" >/dev/null 2>&1 || { log "docker pull failed for $img"; exit 1; }
done

# --- trivy: the full report, then SARIF without the secrets. Every package
#     of the lockfile is a development dependency, and the tools run in the
#     release jobs next to the store credentials, so they are scanned too. ---
if want trivy; then
  log "trivy: filesystem scan (vuln,secret,misconfig)"
  if ! "${TRIVY_RUN[@]}" fs --no-progress --include-dev-deps --ignorefile .trivyignore.yaml \
        --scanners vuln,secret,misconfig --format json --output "$OUT/trivy.json" .; then
    log "trivy: scan failed"; status=1
  elif ! "${TRIVY_RUN[@]}" fs --no-progress --include-dev-deps --ignorefile .trivyignore.yaml \
        --scanners vuln,misconfig --format sarif --output "$OUT/trivy.sarif" .; then
    log "trivy: SARIF pass failed"; status=1
  fi
fi

# --- semgrep: JSON for the gate, SARIF for code scanning ---
if want semgrep; then
  cfgs=()
  for c in $SEMGREP_CONFIGS; do cfgs+=(--config "$c"); done
  log "semgrep: scan ($SEMGREP_CONFIGS)"
  if ! "${SEMGREP_RUN[@]}" scan "${cfgs[@]}" --metrics=off --json --output "$OUT/semgrep.json" .; then
    log "semgrep: scan failed"; status=1
  elif ! "${SEMGREP_RUN[@]}" scan "${cfgs[@]}" --metrics=off --sarif --output "$OUT/semgrep.sarif" .; then
    log "semgrep: SARIF pass failed"; status=1
  else
    # semgrep keeps a finding an inline `nosemgrep` suppressed in the SARIF
    # (marked with `suppressions`) and code scanning raises it all the same;
    # the JSON report and the gate leave it out, so the SARIF does too.
    python3 - "$OUT/semgrep.sarif" <<'PY' || { log "semgrep: cannot filter the SARIF"; status=1; }
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
for run in doc.get("runs", []):
    run["results"] = [r for r in run.get("results", []) if not r.get("suppressions")]
json.dump(doc, open(path, "w"))
PY
  fi
fi

# --- zizmor: every workflow and the dependabot config under .github.
#     --no-exit-codes: a finding is the gate's business, a non-zero exit
#     is a scan that did not run. ---
if want zizmor; then
  online=()
  [ -n "${GH_TOKEN:-}" ] || { online=(--offline); log "zizmor: no GH_TOKEN, online audits skipped"; }
  log "zizmor: workflow audit"
  if ! "${ZIZMOR_RUN[@]}" "${online[@]}" --no-progress --no-exit-codes --format json .github \
        > "$OUT/zizmor.json"; then
    log "zizmor: scan failed"; status=1
  elif ! "${ZIZMOR_RUN[@]}" "${online[@]}" --no-progress --no-exit-codes --format sarif .github \
        > "$OUT/zizmor.sarif"; then
    log "zizmor: SARIF pass failed"; status=1
  fi
fi

# --- amo: the validator of addons.mozilla.org over the build of this tree ---
if want amo; then
  log "amo: web-ext lint over a fresh Firefox build"
  if ! node scripts/build.mjs >/dev/null; then
    log "amo: the build failed"; status=1
  elif ! node_modules/.bin/web-ext lint --source-dir dist/firefox --output json --no-input \
        > "$OUT/amo.json"; then
    # web-ext exits non-zero on validator errors too; the gate reads the
    # report, so only a report that is not JSON is a failed scan.
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT/amo.json" 2>/dev/null \
      || { log "amo: web-ext lint failed"; status=1; }
  fi
fi

# --- gate: count what the reports hold, even when a scan above failed ---
SEC_SCANNERS="$SEC_SCANNERS" SEC_FAIL_TRIVY="$SEC_FAIL_TRIVY" SEC_FAIL_SEMGREP="$SEC_FAIL_SEMGREP" \
SEC_FAIL_ZIZMOR="$SEC_FAIL_ZIZMOR" SEC_FAIL_AMO="$SEC_FAIL_AMO" OUT="$OUT" python3 - <<'PY'
import json, os, sys

out = os.environ["OUT"]
scanners = os.environ["SEC_SCANNERS"].split(",")
summary, failures, details = [], [], []

def load(name):
    try:
        return json.load(open(os.path.join(out, name)))
    except Exception:
        return None

def gate(name, counts, order, floor):
    if floor == "off":
        return
    hits = sum(n for s, n in counts.items() if s in order and order.index(s) >= order.index(floor))
    if hits:
        failures.append(f"GATE-FAIL {name}: {hits} finding(s) at or above {floor}")

if "trivy" in scanners and (doc := load("trivy.json")) is not None:
    order = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
    counts, misconfig = dict.fromkeys(order, 0), dict.fromkeys(order, 0)
    for res in doc.get("Results") or []:
        for v in res.get("Vulnerabilities") or []:
            counts[v.get("Severity", "UNKNOWN")] += 1
            details.append(f"trivy {v.get('Severity')} {v.get('VulnerabilityID')} {v.get('PkgName')}@{v.get('InstalledVersion')} (fixed: {v.get('FixedVersion') or 'no fix'})")
        for s in res.get("Secrets") or []:
            counts[s.get("Severity", "UNKNOWN")] += 1
            details.append(f"trivy {s.get('Severity')} secret {s.get('RuleID')} {res.get('Target')}:{s.get('StartLine')}")
        for m in res.get("Misconfigurations") or []:
            misconfig[m.get("Severity", "UNKNOWN")] += 1
    summary.append("trivy (vuln+secret): " + " ".join(f"{s}={counts[s]}" for s in reversed(order))
                   + " | misconfig (report-only): " + " ".join(f"{s}={misconfig[s]}" for s in reversed(order)))
    gate("trivy", counts, order, os.environ["SEC_FAIL_TRIVY"])

if "semgrep" in scanners and (doc := load("semgrep.json")) is not None:
    order = ["INFO", "WARNING", "ERROR"]
    counts = dict.fromkeys(order, 0)
    for r in doc.get("results", []):
        sev = r.get("extra", {}).get("severity", "INFO")
        counts[sev] = counts.get(sev, 0) + 1
        details.append(f"semgrep {sev} {r.get('check_id')} {r.get('path')}:{r.get('start', {}).get('line')}")
    summary.append("semgrep: " + " ".join(f"{s}={counts[s]}" for s in reversed(order)))
    gate("semgrep", counts, order, os.environ["SEC_FAIL_SEMGREP"])

if "zizmor" in scanners and (doc := load("zizmor.json")) is not None:
    order = ["unknown", "informational", "low", "medium", "high"]
    counts = dict.fromkeys(order, 0)
    for f in doc:
        if f.get("ignored") or f.get("suppressed"):
            continue
        sev = str(f.get("determinations", {}).get("severity", "unknown")).lower()
        counts[sev] = counts.get(sev, 0) + 1
        locs = f.get("locations") or [{}]
        loc = next((l for l in locs if l.get("symbolic", {}).get("kind") == "Primary"), locs[0])
        path = loc.get("symbolic", {}).get("key", {}).get("Local", {}).get("verbatim_path", "?")
        row = loc.get("concrete", {}).get("location", {}).get("start_point", {}).get("row")
        where = path if row is None else f"{path}:{row + 1}"
        details.append(f"zizmor {sev} {f.get('ident')} {where}: {f.get('desc')}")
    summary.append("zizmor: " + " ".join(f"{s}={counts[s]}" for s in reversed(order) if s != "unknown"))
    gate("zizmor", counts, order, os.environ["SEC_FAIL_ZIZMOR"])

if "amo" in scanners and (doc := load("amo.json")) is not None:
    order = ["notice", "warning", "error"]
    counts = {"notice": len(doc.get("notices", [])), "warning": len(doc.get("warnings", [])), "error": len(doc.get("errors", []))}
    for kind in ("errors", "warnings"):
        for m in doc.get(kind, []):
            details.append(f"amo {kind[:-1]} {m.get('code')} {m.get('file') or ''}:{m.get('line') or ''} {m.get('message')}")
    summary.append("amo validator: " + " ".join(f"{s}={counts[s]}" for s in reversed(order)))
    gate("amo validator", counts, order, os.environ["SEC_FAIL_AMO"])

with open(os.path.join(out, "summary.md"), "w") as f:
    f.write("## Security scan\n\n")
    for line in summary:
        f.write(f"- {line}\n")
    for line in failures:
        f.write(f"- :x: {line}\n")
    if details:
        f.write("\n<details><summary>Findings</summary>\n\n")
        for line in details:
            f.write(f"- `{line}`\n")
        f.write("\n</details>\n")
for line in summary + details + failures:
    print(line)
sys.exit(1 if failures else 0)
PY
gate=$?

if [ "$gate" -ne 0 ] || [ "$status" -ne 0 ]; then
  log "FAIL (scans=$([ "$status" -eq 0 ] && echo ok || echo failed), gate=$([ "$gate" -eq 0 ] && echo clean || echo tripped))"
  exit 1
fi
log "PASS (reports in $OUT/)"
