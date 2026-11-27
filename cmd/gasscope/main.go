package main

import (
	"encoding/json"
	"fmt"
	"html"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gasscope/internal/profile"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 2 || (args[0] != "analyze" && args[0] != "bench") {
		return fmt.Errorf("usage: gasscope <analyze|bench> <dir-or-file>")
	}
	root := filepath.FromSlash(args[1])
	if filepath.Base(root) == "..." {
		root = filepath.Dir(root)
	}
	info, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() && (args[0] == "bench" || filepath.Ext(root) != ".gno") {
		return fmt.Errorf("bench requires a directory; analyze requires a directory or .gno file")
	}
	sources := map[string]string{}
	var names []string
	packages := map[string]bool{}
	err = filepath.WalkDir(root, func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && name != root && (strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" || d.Name() == "vendor") {
			return filepath.SkipDir
		}
		if d.IsDir() || filepath.Ext(name) != ".gno" {
			return nil
		}
		data, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(name)
		names = append(names, key)
		sources[key] = string(data)
		packages[filepath.Dir(name)] = true
		return nil
	})
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return fmt.Errorf("no .gno files in %s", root)
	}
	report, err := profile.Analyze(names, sources)
	if err != nil {
		return err
	}
	failed := false
	if args[0] == "bench" {
		if gno, err := exec.LookPath("gno"); err == nil {
			report.Mode = "bench"
			dirs := make([]string, 0, len(packages))
			for dir := range packages {
				dirs = append(dirs, dir)
			}
			sort.Strings(dirs)
			for _, dir := range dirs {
				cmd := exec.Command(gno, "test", "-v")
				cmd.Dir = dir
				data, err := cmd.CombinedOutput()
				run := profile.TestRun{Package: filepath.ToSlash(dir), Passed: err == nil, Output: string(data), TimingMS: map[string]float64{}, GasUsed: map[string]int64{}}
				if err != nil {
					failed = true
					run.Output += "\n" + err.Error()
				}
				for _, line := range timing.FindAllStringSubmatch(string(data), -1) {
					if duration, err := time.ParseDuration(line[2]); err == nil {
						run.TimingMS[line[1]] = float64(duration) / float64(time.Millisecond)
					}
					gas := line[3] + line[4]
					if units, err := strconv.ParseInt(gas, 10, 64); err == nil {
						run.GasUsed[line[1]] = units
					}
				}
				report.Tests = append(report.Tests, run)
			}
		} else {
			report.Note = "gno CLI unavailable; static analysis completed."
			fmt.Fprintln(os.Stderr, report.Note)
		}
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile("gasscope-report.json", append(data, '\n'), 0644); err != nil {
		return err
	}
	if err = os.WriteFile("gasscope-report.svg", []byte(svg(report)), 0644); err != nil {
		return err
	}
	fmt.Printf("gasscope-report.json and gasscope-report.svg · %d functions · %d estimated gas points\n", len(report.Functions), report.TotalGas)
	if failed {
		return fmt.Errorf("one or more Gno test packages failed; see gasscope-report.json")
	}
	return nil
}

var timing = regexp.MustCompile(`(?m)^[ \t]*--- (?:PASS|FAIL): (\S+) \((?:elapsed: )?([0-9.]+(?:ns|µs|ms|s))(?:, gas: (\d+))?[^\r\n]*(?:\r?\n[ \t]*--- GAS:[ \t]*(\d+))?`)

func svg(report profile.Report) string {
	var s strings.Builder
	fmt.Fprintf(&s, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 %d" font-family="monospace" font-size="14"><title>GasScope estimated gas</title><rect width="100%%" height="100%%" fill="#090D16"/><text x="16" y="23" fill="#38BDF8">GasScope · estimated gas points</text>`, len(report.Functions)*28+42)
	max := 1
	for _, f := range report.Functions {
		if f.EstimatedGas > max {
			max = f.EstimatedGas
		}
	}
	for i, f := range report.Functions {
		y := 34 + i*28
		color := "#38BDF8"
		if len(f.Hotspots) > 0 {
			color = "#F97316"
		}
		fmt.Fprintf(&s, `<text x="16" y="%d" fill="#E2E8F0">%s</text><rect x="310" y="%d" width="%d" height="17" fill="%s"><title>%s</title></rect><text x="930" y="%d" fill="#E2E8F0">%s</text>`, y+13, html.EscapeString(f.Name), y, maxWidth(f.EstimatedGas, max), color, html.EscapeString(f.ID), y+13, strconv.Itoa(f.EstimatedGas))
	}
	return s.String() + "</svg>\n"
}

func maxWidth(score, max int) int { return 1 + (score*599)/max }
