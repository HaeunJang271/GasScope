package profile

import (
	"strings"
	"testing"
)

func TestAnalyzeHotspotsAndLocalCalls(t *testing.T) {
	names := []string{"play/render.gno", "play/helpers.gno"}
	report, err := Analyze(names, map[string]string{
		names[0]: `package play
import (
 "gno.land/p/nt/ufmt/v0"
 treepkg "gno.land/p/nt/avl/v0"
 remote "gno.land/r/demo/scores"
)
var tree = treepkg.NewTree()
var state = map[string]int{}
func Render(cur realm, values []string) string {
 var output string
 var items []string
 for _, value := range values {
  output += value + value
  items = append(items, format(value))
  remote.Save(cross(cur), value)
 }
 for key := range state { output += key }
 tree.Iterate("", "", func(k string, v any) bool { return false })
 return output
}
func Safe(values []string) []string {
 results := make([]string, 0, len(values))
 for _, value := range values { results = append(results, value) }
 tree.Iterate("", "", func(k string, v any) bool { return true })
 return results
}
`,
		names[1]: `package play
import formatlib "gno.land/p/nt/ufmt/v0"
func format(s string) string { return formatlib.Sprintf("%s", s) }
`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Functions) != 3 || report.TotalGas <= 0 {
		t.Fatalf("unexpected report: %+v", report)
	}
	found := map[string]bool{}
	for _, f := range report.Functions {
		switch f.Name {
		case "Render":
			var local, crossing bool
			for _, call := range f.Calls {
				local = local || call.Target == "play/helpers.gno:format" && call.InLoop
				crossing = crossing || call.CrossRealm && strings.HasSuffix(call.Target, "/scores.Save")
			}
			if !local || !crossing {
				t.Fatalf("missing call edges: %+v", f.Calls)
			}
		case "Safe":
			if len(f.Hotspots) != 0 {
				t.Fatalf("bounded code flagged: %+v", f.Hotspots)
			}
		case "format":
			if f.Exported || len(f.Hotspots) != 1 || f.Hotspots[0].Rule != "HOT_UFMT_SPRINTF" {
				t.Fatalf("helper called from a loop was not recognized: %+v", f)
			}
		}
		for _, h := range f.Hotspots {
			found[h.Rule] = true
		}
	}
	for rule := range rules {
		if !found[rule] {
			t.Errorf("missing %s", rule)
		}
	}
}
