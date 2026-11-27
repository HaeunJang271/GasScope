package main

import (
	"encoding/json"
	"sort"
	"syscall/js"

	"gasscope/internal/profile"
)

func main() {
	analyze := js.FuncOf(func(_ js.Value, args []js.Value) any {
		var sources map[string]string
		if err := json.Unmarshal([]byte(args[0].String()), &sources); err != nil {
			return map[string]any{"error": err.Error()}
		}
		names := make([]string, 0, len(sources))
		for name := range sources {
			names = append(names, name)
		}
		sort.Strings(names)
		report, err := profile.Analyze(names, sources)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		data, err := json.Marshal(report)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return map[string]any{"report": string(data)}
	})
	js.Global().Set("analyzeGasScope", analyze)
	select {}
}
