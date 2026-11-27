# GasScope

GasScope profiles Gno.land realms with a Go CLI, a reusable benchmark package, an Onyx registry, and a browser dashboard.

## CLI

```sh
go run ./cmd/gasscope analyze ./...
go run ./cmd/gasscope analyze path/to/realm.gno
go run ./cmd/gasscope bench ./packages/gasbench
```

Both commands write `gasscope-report.json` and `gasscope-report.svg` to the working directory. Directory targets scan recursively. The JSON includes function declarations, source locations, calls, realm crossings, and six hotspot rules with allocation risk and suggested code changes. Versioned package imports and package-local calls are resolved from source where possible.

Estimated gas points are a heuristic. Each function starts with one point, each call site adds three, and each hotspot contributes its rule weight. Compare scores from the same analyzer version. Dynamic dispatch, execution counts, and the actual cost of a crossing require runtime measurements.

`bench` runs `gno test -v` in each discovered Gno package directory. Verbose Gno test output supplies elapsed milliseconds and, when available, measured VM gas by test. The timing resolution is whatever the Gno CLI prints. Individual production functions are visible in the static call graph. Failed test runs still write the reports and return a nonzero exit code. If `gno` is missing, the command produces a static report with a fallback note.

## Reusable benchmark package

After deployment, import `gno.land/p/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/gasbench` in a realm or test. Count operations at the call sites you want to budget.

```go
b := gasbench.Begin("load page")
for range records {
    b.AddOps(1)
}
result := b.End()
gasbench.AssertBudget(result.Ops, 100)
markdown := gasbench.FormatMarkdown([]gasbench.Result{result})
```

## Dashboard

```sh
cd web
npm ci
npm run dev
npm run build
```

Node 22 and a Go toolchain on PATH build the React app and its Go WebAssembly module. The dashboard opens with bundled demo source. Use **Live Onyx Analyzer** with `gno.land/r/gnoland/blog` or another full realm path, or import CLI JSON. The browser fetches public source with `vm/qfile` and runs the same rules as the CLI. The call tree expands resolved local calls and labels realm crossings.

The default RPC is `https://rpc.onyx.testnets.gno.land` on chain `onyx-1`. Set `VITE_ONYX_RPC` to a CORS-enabled endpoint if needed. Set `VITE_REGISTRY_PATH` to the deployed registry package path at build time. Imported reports require a realm path for registration. Live reports carry their source realm path.

## Onyx registry

The source targets Gno v1.8 with `gnomod.toml` and crossing functions that take `cur realm`. The default package path is `gno.land/r/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/gasscope_reg`. Deploy to a namespace controlled by your funded Onyx signer. If using a different namespace, update the module path in `gnomod.toml` and the dashboard's registry path. Example deployment with an existing gnokey account:

```sh
gnokey maketx addpkg -pkgpath gno.land/r/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/gasscope_reg \
  -pkgdir ./realms/gasscope_reg -gas-fee 1000000ugnot -gas-wanted 20000000 \
  -broadcast -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 YOUR_KEY
```

`Render("")` shows the top 20 submissions by estimated gas points across the registry. Higher scores rank first and newer submissions break ties. `Render("profiles/0")` exposes the same page as JSON. `ListProfiles(offset)`, `GetProfileCount()`, and `GetReportJSON(id)` expose registry reads. Each submission stores a caller-owned report payload of up to 32 KiB. `VerifyProfile` records a submitter attestation. Submitted metrics and report payloads are self-reported.

## Verification and CI

```sh
go test ./...
(cd packages/gasbench && gno test)
(cd realms/gasscope_reg && gno test)
(cd web && npm run build)
```

The PR workflow uploads JSON and SVG and compares estimated points against the base commit. Set the repository variable `GASSCOPE_MAX_INCREASE` to a nonnegative integer to enforce an increase budget.
